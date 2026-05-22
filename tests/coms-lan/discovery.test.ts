import { describe, expect, it } from "bun:test";
import {
  createDiscoveryPacket,
  DiscoveryPeerCache,
  parseDiscoveryPacket,
} from "../../src/coms-lan/discovery";

describe("discovery packets", () => {
  it("creates metadata-only discovery packets", () => {
    const packet = createDiscoveryPacket({
      nodeId: "node_01KS6QDHA43K8FH6AATBTMATHD",
      hubInstanceId: "hub_01KS6QDHA43K8FH6AATBTMATHE",
      wssPort: 43210,
      startedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(Object.keys(packet).sort()).toEqual([
      "hub_instance_id",
      "m",
      "node_id",
      "started_at",
      "v",
      "wss_port",
    ]);
    expect(JSON.stringify(packet)).not.toMatch(/prompt|secret|private|token|cwd|path/i);
  });

  it("parses valid packets", () => {
    const packet = createDiscoveryPacket({
      nodeId: "node_01KS6QDHA43K8FH6AATBTMATHD",
      hubInstanceId: "hub_01KS6QDHA43K8FH6AATBTMATHE",
      wssPort: 43210,
      startedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(parseDiscoveryPacket(JSON.stringify(packet))).toEqual(packet);
  });

  it("ignores malformed or wrong-magic packets", () => {
    expect(parseDiscoveryPacket("not json")).toBeNull();
    expect(parseDiscoveryPacket(JSON.stringify({ m: "OTHER", v: 1 }))).toBeNull();
    expect(parseDiscoveryPacket(JSON.stringify({ m: "PI-COMS-LAN", v: 2 }))).toBeNull();
  });

  it("rejects packets with invalid service ports", () => {
    const packet = createDiscoveryPacket({
      nodeId: "node_01KS6QDHA43K8FH6AATBTMATHD",
      hubInstanceId: "hub_01KS6QDHA43K8FH6AATBTMATHE",
      wssPort: 43210,
      startedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(parseDiscoveryPacket(JSON.stringify({ ...packet, wss_port: 0 }))).toBeNull();
    expect(parseDiscoveryPacket(JSON.stringify({ ...packet, wss_port: 65536 }))).toBeNull();
  });
});

describe("DiscoveryPeerCache", () => {
  it("ignores self packets", () => {
    const cache = new DiscoveryPeerCache("node_self");

    const result = cache.upsertFromPacket(
      {
        m: "PI-COMS-LAN",
        v: 1,
        node_id: "node_self",
        hub_instance_id: "hub_self",
        wss_port: 4444,
        started_at: "2026-05-21T00:00:00.000Z",
      },
      "192.168.1.10",
      "2026-05-21T00:00:01.000Z"
    );

    expect(result).toBe("ignored_self");
    expect(cache.list()).toEqual([]);
  });

  it("stores discovered peers as untrusted", () => {
    const cache = new DiscoveryPeerCache("node_self");

    const result = cache.upsertFromPacket(
      {
        m: "PI-COMS-LAN",
        v: 1,
        node_id: "node_peer",
        hub_instance_id: "hub_peer",
        wss_port: 4444,
        started_at: "2026-05-21T00:00:00.000Z",
      },
      "192.168.1.10",
      "2026-05-21T00:00:01.000Z"
    );

    expect(result).toBe("discovered");
    expect(cache.list()).toEqual([
      {
        nodeId: "node_peer",
        hubInstanceId: "hub_peer",
        endpoint: "wss://192.168.1.10:4444/v1/hub",
        lastSeenAt: "2026-05-21T00:00:01.000Z",
        trustState: "untrusted",
        authState: "not_attempted",
      },
    ]);
  });

  it("tracks auth state transitions for discovered peers", () => {
    const cache = new DiscoveryPeerCache("node_self");
    cache.upsertFromPacket(
      {
        m: "PI-COMS-LAN",
        v: 1,
        node_id: "node_peer",
        hub_instance_id: "hub_peer",
        wss_port: 4444,
        started_at: "2026-05-21T00:00:00.000Z",
      },
      "192.168.1.10",
      "2026-05-21T00:00:01.000Z"
    );

    cache.markAuthInProgress("node_peer");
    expect(cache.list()[0]).toMatchObject({
      nodeId: "node_peer",
      trustState: "untrusted",
      authState: "in_progress",
    });

    cache.markAuthenticated("node_peer");
    expect(cache.list()[0]).toMatchObject({
      nodeId: "node_peer",
      trustState: "trusted",
      authState: "authenticated",
    });

    cache.markAuthFailed("node_peer");
    expect(cache.list()[0]).toMatchObject({
      nodeId: "node_peer",
      trustState: "auth_failed",
      authState: "failed",
    });
  });
});
