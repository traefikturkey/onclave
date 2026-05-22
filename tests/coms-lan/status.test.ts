import { describe, expect, it } from "bun:test";
import { buildComsLanStatus } from "../../src/coms-lan/status";

describe("buildComsLanStatus", () => {
  it("adds LAN-reachable remote endpoints for non-loopback interfaces", () => {
    const status = buildComsLanStatus({
      endpoint: "https://127.0.0.1:43837",
      started: true,
      publicAuthorizedKeyLine: "ssh-ed25519 AAAA node_test",
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "172.30.20.50", family: "IPv4", internal: false }],
        wlan0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      },
    });

    expect(status.text).toContain("hub: https://127.0.0.1:43837");
    expect(status.text).toContain("remote_endpoints:");
    expect(status.text).toContain("wss://172.30.20.50:43837/v1/hub");
    expect(status.text).toContain("wss://[fe80::1]:43837/v1/hub");
    expect(status.details.remoteEndpoints).toEqual([
      "wss://172.30.20.50:43837/v1/hub",
      "wss://[fe80::1]:43837/v1/hub",
    ]);
  });

  it("omits remote endpoints when only loopback is available", () => {
    const status = buildComsLanStatus({
      endpoint: "https://127.0.0.1:43837",
      started: false,
      publicAuthorizedKeyLine: "ssh-ed25519 AAAA node_test",
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      },
    });

    expect(status.text).not.toContain("remote_endpoints:");
    expect(status.details.remoteEndpoints).toEqual([]);
  });
});
