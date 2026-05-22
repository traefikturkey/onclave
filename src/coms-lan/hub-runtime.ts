import type { AuditEventName, AuditMetadata } from "./audit";
import { AuditedHubRuntime } from "./audited-runtime";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { DiscoveryService, type DiscoveredPeer, type DiscoveryUdpSocket } from "./discovery";
import type { HubState } from "./local-hub";
import { createRemoteHubClient, type RemoteHubClient, type RemoteHubClientIdentity } from "./remote-client";
import {
  LocalAgentRegistry,
  type LocalAgent,
  type LocalAgentRegistration,
} from "./local-registry";
import { MessageRouter, type DeliveredPrompt, type MessageResponse } from "./messages";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type SendPromptFrame,
} from "./transport";
import {
  startWssHubServer,
  type TlsMaterial,
  type WssHubServer,
} from "./wss-transport";

export type ComsLanHubRuntimeOptions = {
  nodeId: string;
  hubInstanceId: string;
  host: string;
  tls: TlsMaterial;
  authorizedKeys: AuthorizedSshEd25519Key[];
  discoverySocket: DiscoveryUdpSocket;
  discoveryPort: number;
  broadcastAddress: string;
  startedAt: string;
  now: () => string;
  staleAfterMs: number;
  offlineAfterMs: number;
  messageTtlMs?: number;
  maxHops?: number;
  deliverPrompt?: (prompt: DeliveredPrompt) => Promise<void>;
  remoteIdentity?: RemoteHubClientIdentity;
  remoteClientFactory?: (peer: DiscoveredPeer) => Pick<RemoteHubClient, "listAgents">;
  audit?: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

export type RemoteAgentListing = {
  peerNodeId: string;
  agent: LocalAgent;
};

export class ComsLanHubRuntime {
  private readonly registry: LocalAgentRegistry;
  private readonly messages: MessageRouter;
  private readonly audit?: AuditedHubRuntime;
  private wssServer: WssHubServer | null = null;
  private discovery: DiscoveryService | null = null;
  private state: HubState | null = null;

  constructor(private readonly options: ComsLanHubRuntimeOptions) {
    this.registry = new LocalAgentRegistry({
      staleAfterMs: options.staleAfterMs,
      offlineAfterMs: options.offlineAfterMs,
    });
    this.audit = options.audit ? new AuditedHubRuntime({ audit: options.audit }) : undefined;
    this.messages = new MessageRouter({
      registry: this.registry,
      now: options.now,
      ttlMs: options.messageTtlMs ?? 1_800_000,
      maxHops: options.maxHops ?? 5,
      deliverPrompt: async (prompt) => {
        this.audit?.messageInbound(prompt);
        await options.deliverPrompt?.(prompt);
      },
    });
  }

  async start(): Promise<void> {
    if (this.wssServer) return;

    this.wssServer = await startWssHubServer({
      host: this.options.host,
      port: 0,
      tls: this.options.tls,
      createProcessor: () => this.createFrameProcessor(),
    });

    this.state = {
      version: 1,
      nodeId: this.options.nodeId,
      hubInstanceId: this.options.hubInstanceId,
      pid: process.pid,
      endpoint: `https://${endpointHost(this.options.host)}:${this.wssServer.port}`,
      startedAt: this.options.startedAt,
    };

    this.discovery = new DiscoveryService({
      socket: this.options.discoverySocket,
      localNodeId: this.options.nodeId,
      hubInstanceId: this.options.hubInstanceId,
      wssPort: this.wssServer.port,
      startedAt: this.options.startedAt,
      discoveryPort: this.options.discoveryPort,
      broadcastAddress: this.options.broadcastAddress,
      intervalMs: 5_000,
      now: this.options.now,
    });
    await this.discovery.start();
  }

  async stop(): Promise<void> {
    if (this.discovery) {
      await this.discovery.stop();
      this.discovery = null;
    }
    if (this.wssServer) {
      this.wssServer.stop();
      this.wssServer = null;
    }
    this.state = null;
  }

  hubState(): HubState {
    if (!this.state) throw new Error("coms-lan hub runtime is not started");
    return this.state;
  }

  wssUrl(): string {
    if (!this.wssServer) throw new Error("coms-lan hub runtime is not started");
    return this.wssServer.url;
  }

  wssPort(): number {
    if (!this.wssServer) throw new Error("coms-lan hub runtime is not started");
    return this.wssServer.port;
  }

  registerLocalAgent(registration: LocalAgentRegistration): LocalAgent {
    const agent = this.registry.register(registration, this.options.now());
    this.audit?.localRegister(registration);
    return agent;
  }

  unregisterLocalAgent(sessionId: string): boolean {
    const removed = this.registry.unregister(sessionId);
    this.audit?.localUnregister(sessionId, removed);
    return removed;
  }

  localAgents(): LocalAgent[] {
    return this.registry.list();
  }

  discoveredPeers(): DiscoveredPeer[] {
    return this.discovery?.peers() ?? [];
  }

  async listTrustedRemoteAgents(peers: DiscoveredPeer[] = this.discoveredPeers()): Promise<RemoteAgentListing[]> {
    const trusted = peers.filter((peer) => peer.trustState === "trusted");
    const listings: RemoteAgentListing[] = [];
    for (const peer of trusted) {
      const client = this.remoteClientFor(peer);
      const agents = await client.listAgents();
      listings.push(...agents.map((agent) => ({ peerNodeId: peer.nodeId, agent })));
    }
    return listings;
  }

  private createFrameProcessor(): HubFrameProcessor {
    return new HubFrameProcessor({
      gate: new HubTransportAuthGate({
        authorizedKeys: this.options.authorizedKeys,
        now: () => new Date(this.options.now()),
        maxSkewMs: 30_000,
      }),
      listAgents: () => this.registry.list(),
      registerLocalAgent: (registration) => this.registerLocalAgent(registration),
      unregisterLocalAgent: (sessionId) => this.unregisterLocalAgent(sessionId),
      onSendPrompt: async (frame) => this.routePrompt(frame),
      getResponse: (msgId) => this.messages.getResponse(msgId),
      submitResponse: (response) => this.submitResponse(response),
    });
  }

  async routePrompt(frame: SendPromptFrame) {
    const result = await this.messages.sendPrompt(frame);
    this.audit?.messageOutbound({
      msgId: frame.msgId,
      targetSessionId: frame.targetSessionId,
      status: result.ok ? result.status : result.error,
    });
    return result;
  }

  submitResponse(response: MessageResponse) {
    const result = this.messages.submitResponse(response);
    if (result.ok) this.audit?.responseInbound(response);
    return result;
  }

  private remoteClientFor(peer: DiscoveredPeer): Pick<RemoteHubClient, "listAgents"> {
    if (this.options.remoteClientFactory) return this.options.remoteClientFactory(peer);
    if (!this.options.remoteIdentity) {
      throw new Error("remote identity is required to list trusted remote agents");
    }
    return createRemoteHubClient({
      identity: this.options.remoteIdentity,
      remote: {
        nodeId: peer.nodeId,
        hubInstanceId: peer.hubInstanceId,
        endpoint: peer.endpoint,
      },
      now: this.options.now,
      rejectUnauthorized: false,
    });
  }
}

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}
