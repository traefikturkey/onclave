import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { DiscoveryService, type DiscoveryUdpSocket } from "./discovery";
import type { HubState } from "./local-hub";
import {
  LocalAgentRegistry,
  type LocalAgent,
  type LocalAgentRegistration,
} from "./local-registry";
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
};

export class ComsLanHubRuntime {
  private readonly registry: LocalAgentRegistry;
  private wssServer: WssHubServer | null = null;
  private discovery: DiscoveryService | null = null;
  private state: HubState | null = null;

  constructor(private readonly options: ComsLanHubRuntimeOptions) {
    this.registry = new LocalAgentRegistry({
      staleAfterMs: options.staleAfterMs,
      offlineAfterMs: options.offlineAfterMs,
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

  private createFrameProcessor(): HubFrameProcessor {
    return new HubFrameProcessor({
      gate: new HubTransportAuthGate({
        authorizedKeys: this.options.authorizedKeys,
        now: () => new Date(this.options.now()),
        maxSkewMs: 30_000,
      }),
      listAgents: () => this.registry.list(),
      onSendPrompt: async (frame) => this.handleSendPrompt(frame),
    });
  }

  private async handleSendPrompt(_frame: SendPromptFrame): Promise<void> {
    return undefined;
  }
}

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}
