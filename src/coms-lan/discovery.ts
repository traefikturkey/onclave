import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { AuditEventName, AuditMetadata } from "./audit";

export type DiscoveryPacket = {
  m: "PI-COMS-LAN";
  v: 1;
  node_id: string;
  hub_instance_id: string;
  wss_port: number;
  started_at: string;
};

export type CreateDiscoveryPacketInput = {
  nodeId: string;
  hubInstanceId: string;
  wssPort: number;
  startedAt: string;
};

export type PeerTrustState = "untrusted" | "trusted" | "auth_failed" | "stale";
export type PeerAuthState = "not_attempted" | "in_progress" | "authenticated" | "failed";

export type DiscoveredPeer = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
  lastSeenAt: string;
  trustState: PeerTrustState;
  authState: PeerAuthState;
};

export type PeerUpsertResult = "ignored_self" | "discovered" | "updated";

export type UdpRemoteInfo = {
  address: string;
  port: number;
};

export type DiscoveryUdpSocket = {
  bind(port: number): Promise<void>;
  setBroadcast(enabled: boolean): void;
  onMessage(handler: (data: Buffer, remote: UdpRemoteInfo) => void): void;
  send(data: Buffer, port: number, address: string): Promise<void>;
  close(): Promise<void>;
};

export type DiscoveryServiceOptions = {
  socket: DiscoveryUdpSocket;
  localNodeId: string;
  hubInstanceId: string;
  wssPort: number;
  startedAt: string;
  discoveryPort: number;
  broadcastAddress: string;
  intervalMs: number;
  now: () => string;
  audit?: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

const DISCOVERY_MAGIC = "PI-COMS-LAN";
const DISCOVERY_VERSION = 1;

export function createDiscoveryPacket(input: CreateDiscoveryPacketInput): DiscoveryPacket {
  if (!isValidPort(input.wssPort)) {
    throw new Error(`invalid discovery service port: ${input.wssPort}`);
  }

  return {
    m: DISCOVERY_MAGIC,
    v: DISCOVERY_VERSION,
    node_id: input.nodeId,
    hub_instance_id: input.hubInstanceId,
    wss_port: input.wssPort,
    started_at: input.startedAt,
  };
}

export function parseDiscoveryPacket(data: string | Uint8Array): DiscoveryPacket | null {
  try {
    const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isDiscoveryPacket(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class DiscoveryPeerCache {
  private readonly peers = new Map<string, DiscoveredPeer>();

  constructor(private readonly localNodeId: string) {}

  upsertFromPacket(packet: DiscoveryPacket, remoteAddress: string, seenAt: string): PeerUpsertResult {
    if (packet.node_id === this.localNodeId) return "ignored_self";

    const existing = this.peers.get(packet.node_id);
    const next: DiscoveredPeer = {
      nodeId: packet.node_id,
      hubInstanceId: packet.hub_instance_id,
      endpoint: `wss://${remoteAddress}:${packet.wss_port}/v1/hub`,
      lastSeenAt: seenAt,
      trustState: existing?.trustState ?? "untrusted",
      authState: existing?.authState ?? "not_attempted",
    };

    this.peers.set(packet.node_id, next);
    return existing ? "updated" : "discovered";
  }

  list(): DiscoveredPeer[] {
    return [...this.peers.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
}

export function createNodeDiscoveryUdpSocket(): DiscoveryUdpSocket {
  return new NodeDiscoveryUdpSocket();
}

class NodeDiscoveryUdpSocket implements DiscoveryUdpSocket {
  private readonly socket: Socket = createSocket("udp4");

  bind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off("error", onError);
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(port);
    });
  }

  setBroadcast(enabled: boolean): void {
    this.socket.setBroadcast(enabled);
  }

  onMessage(handler: (data: Buffer, remote: UdpRemoteInfo) => void): void {
    this.socket.on("message", (data: Buffer, remote: RemoteInfo) => {
      handler(data, { address: remote.address, port: remote.port });
    });
  }

  send(data: Buffer, port: number, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(data, port, address, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.close(() => resolve());
    });
  }
}

export class DiscoveryService {
  private readonly cache: DiscoveryPeerCache;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly options: DiscoveryServiceOptions) {
    if (!isValidPort(options.discoveryPort)) {
      throw new Error(`invalid discovery port: ${options.discoveryPort}`);
    }
    if (options.intervalMs <= 0) {
      throw new Error("discovery interval must be positive");
    }
    this.cache = new DiscoveryPeerCache(options.localNodeId);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.options.socket.onMessage((data, remote) => {
      this.handleMessage(data, remote);
    });
    await this.options.socket.bind(this.options.discoveryPort);
    this.options.socket.setBroadcast(true);
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.options.socket.close();
  }

  async tick(): Promise<void> {
    if (!this.started) return;
    const packet = createDiscoveryPacket({
      nodeId: this.options.localNodeId,
      hubInstanceId: this.options.hubInstanceId,
      wssPort: this.options.wssPort,
      startedAt: this.options.startedAt,
    });
    const data = Buffer.from(JSON.stringify(packet), "utf8");
    await this.options.socket.send(data, this.options.discoveryPort, this.options.broadcastAddress);
  }

  peers(): DiscoveredPeer[] {
    return this.cache.list();
  }

  private handleMessage(data: Buffer, remote: UdpRemoteInfo): void {
    const packet = parseDiscoveryPacket(data);
    if (!packet) {
      void this.options.audit?.("discovery_ignored", { reason: "invalid_packet", remote: remote.address });
      return;
    }
    const result = this.cache.upsertFromPacket(packet, remote.address, this.options.now());
    if (result === "ignored_self") {
      void this.options.audit?.("discovery_ignored", { reason: "self", remote: remote.address });
      return;
    }
    void this.options.audit?.("discovery_seen", {
      node_id: packet.node_id,
      endpoint: `wss://${remote.address}:${packet.wss_port}/v1/hub`,
      result,
    });
  }
}

function isDiscoveryPacket(value: unknown): value is DiscoveryPacket {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.m === DISCOVERY_MAGIC &&
    record.v === DISCOVERY_VERSION &&
    typeof record.node_id === "string" &&
    record.node_id.length > 0 &&
    typeof record.hub_instance_id === "string" &&
    record.hub_instance_id.length > 0 &&
    typeof record.wss_port === "number" &&
    isValidPort(record.wss_port) &&
    typeof record.started_at === "string" &&
    record.started_at.length > 0
  );
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}
