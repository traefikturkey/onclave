type NetworkInterfaceInfo = {
  address: string;
  family: string | number;
  internal: boolean;
};

export type BuildComsLanStatusInput = {
  endpoint: string;
  started: boolean;
  publicAuthorizedKeyLine: string;
  networkInterfaces: Record<string, NetworkInterfaceInfo[] | undefined>;
};

export function buildComsLanStatus(input: BuildComsLanStatusInput): {
  text: string;
  details: {
    endpoint: string;
    started: boolean;
    publicAuthorizedKeyLine: string;
    remoteEndpoints: string[];
  };
} {
  const remoteEndpoints = deriveRemoteEndpoints(input.endpoint, input.networkInterfaces);
  const lines = [
    `hub: ${input.endpoint}`,
    `started_here: ${input.started}`,
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
      publicAuthorizedKeyLine: input.publicAuthorizedKeyLine,
      remoteEndpoints,
    },
  };
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
