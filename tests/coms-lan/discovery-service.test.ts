import { describe, expect, it } from "bun:test";
import {
  DiscoveryService,
  type DiscoveryUdpSocket,
  type UdpRemoteInfo,
} from "../../src/coms-lan/discovery";

describe("DiscoveryService", () => {
  it("binds the UDP socket and broadcasts presence immediately on start", async () => {
    const socket = new FakeUdpSocket();
    const service = createService(socket);

    await service.start();

    expect(socket.boundPort).toBe(48889);
    expect(socket.broadcastEnabled).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.port).toBe(48889);
    expect(socket.sent[0]?.address).toBe("255.255.255.255");
    expect(JSON.parse(socket.sent[0]?.data.toString("utf8") ?? "{}")).toMatchObject({
      m: "PI-COMS-LAN",
      v: 1,
      node_id: "node_self",
      hub_instance_id: "hub_self",
      wss_port: 4444,
    });

    await service.stop();
  });

  it("stores inbound valid packets as untrusted peers", async () => {
    const socket = new FakeUdpSocket();
    const service = createService(socket, () => "2026-05-21T00:00:01.000Z");
    await service.start();

    socket.emitMessage(
      Buffer.from(
        JSON.stringify({
          m: "PI-COMS-LAN",
          v: 1,
          node_id: "node_peer",
          hub_instance_id: "hub_peer",
          wss_port: 5555,
          started_at: "2026-05-21T00:00:00.000Z",
        })
      ),
      { address: "192.168.1.20", port: 48889 }
    );

    expect(service.peers()).toEqual([
      {
        nodeId: "node_peer",
        hubInstanceId: "hub_peer",
        endpoint: "wss://192.168.1.20:5555/v1/hub",
        lastSeenAt: "2026-05-21T00:00:01.000Z",
        trustState: "untrusted",
        authState: "not_attempted",
      },
    ]);

    await service.stop();
  });

  it("ignores malformed and self packets", async () => {
    const socket = new FakeUdpSocket();
    const service = createService(socket);
    await service.start();

    socket.emitMessage(Buffer.from("not json"), { address: "192.168.1.20", port: 48889 });
    socket.emitMessage(
      Buffer.from(
        JSON.stringify({
          m: "PI-COMS-LAN",
          v: 1,
          node_id: "node_self",
          hub_instance_id: "hub_self",
          wss_port: 4444,
          started_at: "2026-05-21T00:00:00.000Z",
        })
      ),
      { address: "127.0.0.1", port: 48889 }
    );

    expect(service.peers()).toEqual([]);

    await service.stop();
  });

  it("broadcasts again when tick is called", async () => {
    const socket = new FakeUdpSocket();
    const service = createService(socket);
    await service.start();

    await service.tick();

    expect(socket.sent).toHaveLength(2);

    await service.stop();
  });

  it("closes the socket on stop and does not broadcast after stop", async () => {
    const socket = new FakeUdpSocket();
    const service = createService(socket);
    await service.start();
    await service.stop();
    await service.tick();

    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(1);
  });
});

function createService(
  socket: DiscoveryUdpSocket,
  now: () => string = () => "2026-05-21T00:00:00.000Z"
): DiscoveryService {
  return new DiscoveryService({
    socket,
    localNodeId: "node_self",
    hubInstanceId: "hub_self",
    wssPort: 4444,
    startedAt: "2026-05-21T00:00:00.000Z",
    discoveryPort: 48889,
    broadcastAddress: "255.255.255.255",
    intervalMs: 60_000,
    now,
  });
}

class FakeUdpSocket implements DiscoveryUdpSocket {
  boundPort: number | null = null;
  broadcastEnabled = false;
  closed = false;
  sent: Array<{ data: Buffer; port: number; address: string }> = [];
  private messageHandler: ((data: Buffer, remote: UdpRemoteInfo) => void) | null = null;

  async bind(port: number): Promise<void> {
    this.boundPort = port;
  }

  setBroadcast(enabled: boolean): void {
    this.broadcastEnabled = enabled;
  }

  onMessage(handler: (data: Buffer, remote: UdpRemoteInfo) => void): void {
    this.messageHandler = handler;
  }

  async send(data: Buffer, port: number, address: string): Promise<void> {
    this.sent.push({ data, port, address });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitMessage(data: Buffer, remote: UdpRemoteInfo): void {
    this.messageHandler?.(data, remote);
  }
}
