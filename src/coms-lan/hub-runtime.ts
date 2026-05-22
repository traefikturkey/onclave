import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { DiscoveryService, type DiscoveredPeer, type DiscoveryUdpSocket } from "./discovery";
import type { HubState } from "./local-hub";
import { createRemoteHubClient, type RemoteHubClient, type RemoteHubClientIdentity } from "./remote-client";
import {
  LocalAgentRegistry,
  type LocalAgent,
  type LocalAgentRegistration,
} from "./local-registry";
import { MessageRouter, type DeliveredPrompt } from "./messages";
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
};

export type RemoteAgentListing = {
  peerNodeId: string;
  agent: LocalAgent;
};

export class ComsLanHubRuntime {
  private readonly registry: LocalAgentRegistry;
  private readonly messages: MessageRouter;
  private wssServer: WssHubServer | null = null;
  private discovery: DiscoveryService | null = null;
  private state: HubState | null = null;

  constructor(private readonly options: ComsLanHubRuntimeOptions) {
    this.registry = new LocalAgentRegistry({
      staleAfterMs: options.staleAfterMs,
      offlineAfterMs: options.offlineAfterMs,
    });
    this.messages = new MessageRouter({
      registry: this.registry,
      now: options.now,
      ttlMs: options.messageTtlMs ?? 1_800_000,
      maxHops: options.maxHops ?? 5,
      deliverPrompt: options.deliverPrompt ?? (async () => undefined),
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
    return this.registry.register(registration, this.options.now());
  }

  unregisterLocalAgent(sessionId: string): boolean {
    return this.registry.unregister(sessionId);
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
      onSendPrompt: async (frame) => this.handleSendPrompt(frame),
      getResponse: (msgId) => this.messages.getResponse(msgId),
      submitResponse: (response) => this.messages.submitResponse(response),
    });
  }

  private async handleSendPrompt(frame: SendPromptFrame) {
    return this.messages.sendPrompt(frame);
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
