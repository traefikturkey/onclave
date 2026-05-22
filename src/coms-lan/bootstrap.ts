import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { ComsLanHubRuntime, type ComsLanHubRuntimeOptions } from "./hub-runtime";
import type { HubState } from "./local-hub";
import { startOrDiscoverLocalHub } from "./local-hub";
import type { ComsLanIdentity } from "./identity";
import { loadOrCreateIdentity } from "./identity";
import type { ComsLanPaths } from "./state";
import { loadOrCreateTlsMaterial, type TlsMaterialGenerator } from "./tls";
import { formatAuthorizedKeyLine, loadAuthorizedKeys } from "./trust";
import { createNodeDiscoveryUdpSocket, type DiscoveredPeer, type DiscoveryUdpSocket } from "./discovery";
import type { LocalAgent, LocalAgentRegistration } from "./local-registry";
import type { DeliveredPrompt } from "./messages";
import type { TlsMaterial } from "./wss-transport";

export type HubRuntimeHandle = {
  state: HubState;
  stop: () => Promise<void>;
  registerLocalAgent?: (registration: LocalAgentRegistration) => LocalAgent;
  unregisterLocalAgent?: (sessionId: string) => boolean;
  localAgents?: () => LocalAgent[];
  discoveredPeers?: () => DiscoveredPeer[];
};

export type BootstrapRuntimeInput = {
  identity: ComsLanIdentity;
  hubInstanceId: string;
  tls: TlsMaterial;
  authorizedKeys: AuthorizedSshEd25519Key[];
};

export type BootstrapLocalHubOptions = {
  host: string;
  discoveryPort: number;
  broadcastAddress: string;
  now: () => string;
  healthCheck: (endpoint: string) => Promise<boolean>;
  tlsGenerator?: TlsMaterialGenerator;
  discoverySocketFactory?: () => DiscoveryUdpSocket;
  deliverPrompt?: (prompt: DeliveredPrompt) => Promise<void>;
  runtimeFactory?: (input: BootstrapRuntimeInput) => Promise<HubRuntimeHandle>;
};

export type BootstrapLocalHubResult = {
  identity: ComsLanIdentity;
  publicAuthorizedKeyLine: string;
  authorizedKeys: AuthorizedSshEd25519Key[];
  state: HubState;
  started: boolean;
  runtime: HubRuntimeHandle | null;
};

export async function bootstrapLocalHub(
  paths: ComsLanPaths,
  options: BootstrapLocalHubOptions
): Promise<BootstrapLocalHubResult> {
  const identity = await loadOrCreateIdentity(paths);
  const publicAuthorizedKeyLine = formatAuthorizedKeyLine(identity);
  const authorizedKeys = await loadAuthorizedKeys(paths);
  let runtime: HubRuntimeHandle | null = null;

  const result = await startOrDiscoverLocalHub(paths, {
    healthCheck: options.healthCheck,
    startHub: async () => {
      const tls = await loadOrCreateTlsMaterial(paths, options.tlsGenerator);
      const hubInstanceId = `hub_${identity.nodeId.slice(-26)}`;
      runtime = await createRuntime(paths, options, {
        identity,
        hubInstanceId,
        tls,
        authorizedKeys,
      });
      return runtime.state;
    },
  });

  return {
    identity,
    publicAuthorizedKeyLine,
    authorizedKeys,
    state: result.state,
    started: result.started,
    runtime: result.started ? runtime : null,
  };
}

async function createRuntime(
  _paths: ComsLanPaths,
  options: BootstrapLocalHubOptions,
  input: BootstrapRuntimeInput
): Promise<HubRuntimeHandle> {
  if (options.runtimeFactory) return options.runtimeFactory(input);

  const runtime = new ComsLanHubRuntime({
    nodeId: input.identity.nodeId,
    hubInstanceId: input.hubInstanceId,
    host: options.host,
    tls: input.tls,
    authorizedKeys: input.authorizedKeys,
    discoverySocket: options.discoverySocketFactory?.() ?? createNodeDiscoveryUdpSocket(),
    discoveryPort: options.discoveryPort,
    broadcastAddress: options.broadcastAddress,
    startedAt: options.now(),
    now: options.now,
    staleAfterMs: 30_000,
    offlineAfterMs: 60_000,
    deliverPrompt: options.deliverPrompt,
  } satisfies ComsLanHubRuntimeOptions);
  await runtime.start();
  return {
    state: runtime.hubState(),
    stop: async () => runtime.stop(),
    registerLocalAgent: (registration) => runtime.registerLocalAgent(registration),
    unregisterLocalAgent: (sessionId) => runtime.unregisterLocalAgent(sessionId),
    localAgents: () => runtime.localAgents(),
    discoveredPeers: () => runtime.discoveredPeers(),
  };
}
