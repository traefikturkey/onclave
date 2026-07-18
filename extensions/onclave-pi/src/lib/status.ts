import type { StaticPeerConfig } from "./config";
import type { DiscoveredPeer, PeerAuthState, PeerTrustState } from "./discovery";
import type { LocalAgent } from "./local-registry";

type NetworkInterfaceInfo = {
  address: string;
  family: string | number;
  internal: boolean;
};

export type BuildOnclaveStatusInput = {
  endpoint: string;
  started: boolean;
  nodeId: string;
  hubInstanceId: string;
  publicAuthorizedKeyLine: string;
  networkInterfaces: Record<string, NetworkInterfaceInfo[] | undefined>;
};

export function buildOnclaveStatus(input: BuildOnclaveStatusInput): {
  text: string;
  details: {
    endpoint: string;
    started: boolean;
    nodeId: string;
    hubInstanceId: string;
    publicAuthorizedKeyLine: string;
    remoteEndpoints: string[];
  };
} {
  const remoteEndpoints = deriveRemoteEndpoints(input.endpoint, input.networkInterfaces);
  const lines = [
    `hub: ${input.endpoint}`,
    `started_here: ${input.started}`,
    `node_id: ${input.nodeId}`,
    `hub_instance_id: ${input.hubInstanceId}`,
    `public_key: ${input.publicAuthorizedKeyLine}`,
  ];
  if (remoteEndpoints.length > 0) {
    lines.push("remote_endpoints:");
    for (const endpoint of remoteEndpoints) {
      lines.push(`- ${endpoint}`);
    }
  }
  return {
    text: lines.join("\n"),
    details: {
      endpoint: input.endpoint,
      started: input.started,
      nodeId: input.nodeId,
      hubInstanceId: input.hubInstanceId,
      publicAuthorizedKeyLine: input.publicAuthorizedKeyLine,
      remoteEndpoints,
    },
  };
}

export type KnownOnclavePeerSource = "discovered" | "discovered+static" | "static";

export type KnownOnclavePeer = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
  trustState: PeerTrustState;
  authState: PeerAuthState;
  source: KnownOnclavePeerSource;
  lastSeenAt?: string;
  name?: string;
  peerName?: string;
};

export function buildKnownOnclavePeers(input: {
  discoveredPeers: DiscoveredPeer[];
  staticPeers: StaticPeerConfig[];
  learnedPeerNames?: ReadonlyMap<string, string>;
}): KnownOnclavePeer[] {
  const staticPeersByNodeId = new Map(input.staticPeers.map((peer) => [peer.nodeId, peer]));
  const knownPeers = input.discoveredPeers.map((peer): KnownOnclavePeer => {
    const staticPeer = staticPeersByNodeId.get(peer.nodeId);
    const learnedPeerName = input.learnedPeerNames?.get(peer.nodeId);
    return {
      ...peer,
      source: staticPeer ? "discovered+static" : "discovered",
      ...(staticPeer?.name ? { name: staticPeer.name } : {}),
      ...(learnedPeerName ? { peerName: learnedPeerName } : {}),
    };
  });

  const discoveredNodeIds = new Set(input.discoveredPeers.map((peer) => peer.nodeId));
  for (const peer of input.staticPeers) {
    if (discoveredNodeIds.has(peer.nodeId)) continue;
    const learnedPeerName = input.learnedPeerNames?.get(peer.nodeId);
    knownPeers.push({
      nodeId: peer.nodeId,
      hubInstanceId: peer.hubInstanceId,
      endpoint: peer.endpoint,
      trustState: "stale",
      authState: "not_attempted",
      source: "static",
      ...(peer.name ? { name: peer.name } : {}),
      ...(learnedPeerName ? { peerName: learnedPeerName } : {}),
    });
  }

  return knownPeers;
}

export function resolveOnclavePeerDisplayName(input: {
  nodeId: string;
  name?: string;
  peerName?: string;
}): string {
  if (input.peerName) return input.peerName;
  if (input.name) return input.name;
  return shortOnclaveNodeId(input.nodeId);
}

export function buildOnclavePeers(input: {
  discoveredPeers: DiscoveredPeer[];
  staticPeers: StaticPeerConfig[];
  learnedPeerNames?: ReadonlyMap<string, string>;
}): {
  text: string;
  details: {
    knownPeers: KnownOnclavePeer[];
    discoveredPeers: Array<KnownOnclavePeer & DiscoveredPeer>;
    staticPeers: StaticPeerConfig[];
  };
} {
  const knownPeers = buildKnownOnclavePeers(input);
  const discoveredPeers = knownPeers.filter((peer): peer is KnownOnclavePeer & DiscoveredPeer => peer.source !== "static");

  const lines = [`known_peers: ${knownPeers.length}`];
  for (const peer of knownPeers) {
    lines.push(formatKnownPeerLine(peer));
  }

  lines.push(`discovered_peers: ${input.discoveredPeers.length}`);
  for (const peer of discoveredPeers) {
    lines.push(
      [
        "-",
        peer.name ? `name=${peer.name}` : null,
        peer.peerName ? `peer_name=${peer.peerName}` : null,
        `node_id=${peer.nodeId}`,
        `hub_instance_id=${peer.hubInstanceId}`,
        `endpoint=${peer.endpoint}`,
        `trust_state=${peer.trustState}`,
        `auth_state=${peer.authState}`,
        `last_seen_at=${peer.lastSeenAt}`,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  lines.push(`static_peers: ${input.staticPeers.length}`);
  for (const peer of input.staticPeers) {
    lines.push(
      [
        "-",
        peer.name ? `name=${peer.name}` : null,
        `node_id=${peer.nodeId}`,
        `hub_instance_id=${peer.hubInstanceId}`,
        `endpoint=${peer.endpoint}`,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  return { text: lines.join("\n"), details: { knownPeers, discoveredPeers, staticPeers: input.staticPeers } };
}

function formatKnownPeerLine(peer: KnownOnclavePeer): string {
  return [
    "-",
    peer.name ? `name=${peer.name}` : null,
    peer.peerName ? `peer_name=${peer.peerName}` : null,
    `source=${peer.source}`,
    `node_id=${peer.nodeId}`,
    `hub_instance_id=${peer.hubInstanceId}`,
    `endpoint=${peer.endpoint}`,
    `trust_state=${peer.trustState}`,
    `auth_state=${peer.authState}`,
    peer.lastSeenAt ? `last_seen_at=${peer.lastSeenAt}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildOnclaveAgentList(input: {
  heading: "local_agents" | "remote_agents";
  agents: LocalAgent[];
}): {
  text: string;
} {
  const lines = [`${input.heading}: ${input.agents.length}`];
  for (const agent of input.agents) {
    lines.push(
      [
        "-",
        `session_id=${agent.sessionId}`,
        `name=${agent.name}`,
        `project=${agent.projectLabel}`,
        `status=${agent.status}`,
        `model=${agent.model}`,
      ].join(" ")
    );
  }
  return { text: lines.join("\n") };
}

export function deriveRemoteEndpoints(
  endpoint: string,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): string[] {
  const url = new URL(endpoint);
  const port = url.port;
  if (!port) return [];

  const remoteEndpoints = new Set<string>();
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    if (isLikelyVirtualInterface(interfaceName)) continue;
    for (const entry of entries ?? []) {
      const candidate = createRemoteEndpointCandidate(entry, port);
      if (!candidate) continue;
      remoteEndpoints.add(candidate.endpoint);
    }
  }
  return [...remoteEndpoints].sort(compareRemoteEndpoints);
}

export function choosePreferredRemoteEndpoint(
  endpoint: string,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): string {
  return deriveRemoteEndpoints(endpoint, interfaces)[0] ?? endpoint.replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/hub";
}

function createRemoteEndpointCandidate(
  entry: NetworkInterfaceInfo | undefined,
  port: string
): { endpoint: string } | null {
  if (!entry || entry.internal || !entry.address) return null;

  const family = normalizeFamily(entry.family);
  if (!family) return null;
  if (family === "IPv4" && isExcludedIpv4Address(entry.address)) return null;
  if (family === "IPv6" && isExcludedIpv6Address(entry.address)) return null;

  const host = family === "IPv6" ? `[${entry.address}]` : entry.address;
  return { endpoint: `wss://${host}:${port}/v1/hub` };
}

function compareRemoteEndpoints(left: string, right: string): number {
  const leftWeight = remoteEndpointSortWeight(left);
  const rightWeight = remoteEndpointSortWeight(right);
  return leftWeight - rightWeight || left.localeCompare(right);
}

function remoteEndpointSortWeight(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
    if (isRfc1918Ipv4(host)) return 0;
    if (/^[0-9.]+$/.test(host)) return 1;
    if (host.includes(":")) return 2;
  } catch {
    return 99;
  }
  return 50;
}

function normalizeFamily(family: string | number): "IPv4" | "IPv6" | null {
  const normalized = typeof family === "string" ? family : family === 6 ? "IPv6" : family === 4 ? "IPv4" : null;
  return normalized === "IPv4" || normalized === "IPv6" ? normalized : null;
}

function isExcludedIpv4Address(address: string): boolean {
  return address === "0.0.0.0" || address.startsWith("127.");
}

function isExcludedIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:");
}

function isRfc1918Ipv4(address: string): boolean {
  return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function isLikelyVirtualInterface(interfaceName: string): boolean {
  return /^(lo|loopback|docker\d*|br-|veth|virbr|cni|podman|vboxnet|vmnet|zt|tailscale|tun|tap)/i.test(interfaceName);
}

function shortOnclaveNodeId(nodeId: string): string {
  return nodeId.startsWith("node_") ? nodeId.slice(5, 13) : nodeId.slice(0, 8);
}
