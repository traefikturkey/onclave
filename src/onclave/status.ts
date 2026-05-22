import type { StaticPeerConfig } from "./config";
import type { DiscoveredPeer } from "./discovery";
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

export function buildOnclavePeers(input: {
  discoveredPeers: DiscoveredPeer[];
  staticPeers: StaticPeerConfig[];
}): {
  text: string;
} {
  const lines = [
    `discovered_peers: ${input.discoveredPeers.length}`,
  ];
  for (const peer of input.discoveredPeers) {
    lines.push(
      [
        "-",
        `node_id=${peer.nodeId}`,
        `hub_instance_id=${peer.hubInstanceId}`,
        `endpoint=${peer.endpoint}`,
        `trust_state=${peer.trustState}`,
        `auth_state=${peer.authState}`,
        `last_seen_at=${peer.lastSeenAt}`,
      ].join(" ")
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
      ].filter(Boolean).join(" ")
    );
  }
  return { text: lines.join("\n") };
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

function deriveRemoteEndpoints(
  endpoint: string,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): string[] {
  const url = new URL(endpoint);
  const port = url.port;
  if (!port) return [];

  const remoteEndpoints = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || !entry.address) continue;
      const family = typeof entry.family === "string" ? entry.family : entry.family === 6 ? "IPv6" : "IPv4";
      if (family !== "IPv4" && family !== "IPv6") continue;
      const host = family === "IPv6" ? `[${entry.address}]` : entry.address;
      remoteEndpoints.add(`wss://${host}:${port}/v1/hub`);
    }
  }
  return [...remoteEndpoints].sort();
}
