import type { AuditEventName, AuditMetadata } from "./audit";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { OnclaveHubRuntime, type OnclaveHubRuntimeOptions } from "./hub-runtime";
import type { HubState } from "./local-hub";
import { startOrDiscoverLocalHub } from "./local-hub";
import type { OnclaveIdentity } from "./identity";
import { deriveLocalAuthToken, loadIdentityPrivateKeyHex, loadOrCreateIdentity } from "./identity";
import type { OnclavePaths } from "./state";
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
  markPeerAuthInProgress?: (nodeId: string) => void;
  markPeerAuthenticated?: (nodeId: string) => void;
  markPeerAuthFailed?: (nodeId: string) => void;
};

export type BootstrapRuntimeInput = {
  identity: OnclaveIdentity;
  privateKeyHex: string;
  localAuthToken?: string;
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
  audit?: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
  runtimeFactory?: (input: BootstrapRuntimeInput) => Promise<HubRuntimeHandle>;
};

export type BootstrapLocalHubResult = {
  identity: OnclaveIdentity;
  publicAuthorizedKeyLine: string;
  authorizedKeys: AuthorizedSshEd25519Key[];
  state: HubState;
  localAuthToken: string;
  started: boolean;
  runtime: HubRuntimeHandle | null;
};

export async function bootstrapLocalHub(
  paths: OnclavePaths,
  options: BootstrapLocalHubOptions
): Promise<BootstrapLocalHubResult> {
  const identity = await loadOrCreateIdentity(paths);
  const publicAuthorizedKeyLine = formatAuthorizedKeyLine(identity);
  const authorizedKeys = await loadAuthorizedKeys(paths);
  const privateKeyHex = await loadIdentityPrivateKeyHex(paths);
  const localAuthToken = deriveLocalAuthToken(identity.nodeId, privateKeyHex);
  void options.audit?.("trust_loaded", { count: authorizedKeys.length });
  let runtime: HubRuntimeHandle | null = null;

  const result = await startOrDiscoverLocalHub(paths, {
    healthCheck: options.healthCheck,
    startHub: async () => {
      const tls = await loadOrCreateTlsMaterial(paths, options.tlsGenerator);
      const hubInstanceId = `hub_${identity.nodeId.slice(-26)}`;
      runtime = await createRuntime(paths, options, {
        identity,
        privateKeyHex,
        localAuthToken,
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
    localAuthToken,
    started: result.started,
    runtime: result.started ? runtime : null,
  };
}

async function createRuntime(
  _paths: OnclavePaths,
  options: BootstrapLocalHubOptions,
  input: BootstrapRuntimeInput
): Promise<HubRuntimeHandle> {
  if (options.runtimeFactory) return options.runtimeFactory(input);

  const runtime = new OnclaveHubRuntime({
    nodeId: input.identity.nodeId,
    hubInstanceId: input.hubInstanceId,
    host: options.host,
    tls: input.tls,
    authorizedKeys: input.authorizedKeys,
    localPublicKeyHex: input.identity.publicKey,
    localPrivateKeyHex: input.privateKeyHex,
    localAuthToken: input.localAuthToken,
    discoverySocket: options.discoverySocketFactory?.() ?? createNodeDiscoveryUdpSocket(),
    discoveryPort: options.discoveryPort,
    broadcastAddress: options.broadcastAddress,
    startedAt: options.now(),
    now: options.now,
    staleAfterMs: 30_000,
    offlineAfterMs: 60_000,
    deliverPrompt: options.deliverPrompt,
    audit: options.audit,
  } satisfies OnclaveHubRuntimeOptions);
  await runtime.start();
  return {
    state: runtime.hubState(),
    stop: async () => runtime.stop(),
    registerLocalAgent: (registration) => runtime.registerLocalAgent(registration),
    unregisterLocalAgent: (sessionId) => runtime.unregisterLocalAgent(sessionId),
    localAgents: () => runtime.localAgents(),
    discoveredPeers: () => runtime.discoveredPeers(),
    markPeerAuthInProgress: (nodeId) => runtime.markPeerAuthInProgress(nodeId),
    markPeerAuthenticated: (nodeId) => runtime.markPeerAuthenticated(nodeId),
    markPeerAuthFailed: (nodeId) => runtime.markPeerAuthFailed(nodeId),
  };
}
