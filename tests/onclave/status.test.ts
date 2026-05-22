import { describe, expect, it } from "bun:test";
import type { StaticPeerConfig } from "../../src/onclave/config";
import type { DiscoveredPeer } from "../../src/onclave/discovery";
import type { LocalAgent } from "../../src/onclave/local-registry";
import {
  buildOnclaveAgentList,
  buildOnclavePeers,
  buildOnclaveStatus,
} from "../../src/onclave/status";

describe("buildOnclaveStatus", () => {
  it("includes live node and hub IDs plus filtered LAN-reachable endpoints", () => {
    const status = buildOnclaveStatus({
      endpoint: "https://127.0.0.1:43837",
      started: true,
      nodeId: "node_01TESTNODEID00000000000000",
      hubInstanceId: "hub_01TESTNODEID00000000000000",
      publicAuthorizedKeyLine: "ssh-ed25519 AAAA node_test",
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "172.30.20.50", family: "IPv4", internal: false }],
        docker0: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
        "br-123": [{ address: "172.19.0.1", family: "IPv4", internal: false }],
        wlan0: [{ address: "fe80::1", family: "IPv6", internal: false }],
        en0: [{ address: "2001:db8::10", family: "IPv6", internal: false }],
      },
    });

    expect(status.text).toContain("hub: https://127.0.0.1:43837");
    expect(status.text).toContain("node_id: node_01TESTNODEID00000000000000");
    expect(status.text).toContain("hub_instance_id: hub_01TESTNODEID00000000000000");
    expect(status.text).toContain("remote_endpoints:");
    expect(status.text).toContain("wss://172.30.20.50:43837/v1/hub");
    expect(status.text).toContain("wss://[2001:db8::10]:43837/v1/hub");
    expect(status.text).not.toContain("172.18.0.1");
    expect(status.text).not.toContain("172.19.0.1");
    expect(status.text).not.toContain("fe80::1");
    expect(status.details.remoteEndpoints).toEqual([
      "wss://172.30.20.50:43837/v1/hub",
      "wss://[2001:db8::10]:43837/v1/hub",
    ]);
  });

  it("omits remote endpoints when only loopback or filtered interfaces are available", () => {
    const status = buildOnclaveStatus({
      endpoint: "https://127.0.0.1:43837",
      started: false,
      nodeId: "node_01TESTNODEID00000000000000",
      hubInstanceId: "hub_01TESTNODEID00000000000000",
      publicAuthorizedKeyLine: "ssh-ed25519 AAAA node_test",
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        docker0: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
        wlan0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      },
    });

    expect(status.text).not.toContain("remote_endpoints:");
    expect(status.details.remoteEndpoints).toEqual([]);
  });
});

describe("buildOnclavePeers", () => {
  it("renders discovered peer metadata and static peers in visible text", () => {
    const discoveredPeers: DiscoveredPeer[] = [
      {
        nodeId: "node_01PEER00000000000000000000",
        hubInstanceId: "hub_01PEER00000000000000000000",
        endpoint: "wss://172.30.20.51:33105/v1/hub",
        lastSeenAt: "2026-05-22T16:00:00.000Z",
        trustState: "trusted",
        authState: "authenticated",
      },
    ];
    const staticPeers: StaticPeerConfig[] = [
      {
        name: "host-b",
        nodeId: "node_01PEER00000000000000000000",
        hubInstanceId: "hub_01PEER00000000000000000000",
        endpoint: "wss://172.30.20.51:33105/v1/hub",
      },
    ];

    const peers = buildOnclavePeers({ discoveredPeers, staticPeers });

    expect(peers.text).toContain("discovered_peers: 1");
    expect(peers.text).toContain("node_id=node_01PEER00000000000000000000");
    expect(peers.text).toContain("hub_instance_id=hub_01PEER00000000000000000000");
    expect(peers.text).toContain("endpoint=wss://172.30.20.51:33105/v1/hub");
    expect(peers.text).toContain("trust_state=trusted");
    expect(peers.text).toContain("auth_state=authenticated");
    expect(peers.text).toContain("static_peers: 1");
    expect(peers.text).toContain("name=host-b");
  });
});

describe("buildOnclaveAgentList", () => {
  it("renders visible agent details including session id and model", () => {
    const agents: LocalAgent[] = [
      {
        sessionId: "2026_05_22T15_46_29_071Z_jsonl",
        instanceId: "pi_123",
        name: "agent-main",
        projectLabel: "onclave@main",
        model: "claude-sonnet",
        purpose: "testing",
        color: "#336699",
        explicit: false,
        deliveryEndpoint: "local://session-1",
        status: "online",
        queueDepth: 0,
        contextUsedPct: 21,
        registeredAt: "2026-05-22T15:46:29.000Z",
        lastSeenAt: "2026-05-22T16:00:00.000Z",
      },
    ];

    const result = buildOnclaveAgentList({ heading: "remote_agents", agents });

    expect(result.text).toContain("remote_agents: 1");
    expect(result.text).toContain("session_id=2026_05_22T15_46_29_071Z_jsonl");
    expect(result.text).toContain("name=agent-main");
    expect(result.text).toContain("project=onclave@main");
    expect(result.text).toContain("status=online");
    expect(result.text).toContain("model=claude-sonnet");
  });
});
