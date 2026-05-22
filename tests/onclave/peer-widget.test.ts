import { describe, expect, it } from "bun:test";
import { formatPeerState, renderOnclavePeerWidget } from "../../src/onclave/peer-widget";

describe("renderOnclavePeerWidget", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  it("renders a boxed peer panel similar to the coms-net widget", () => {
    const lines = renderOnclavePeerWidget(
      72,
      {
        localLabel: "host-a",
        peers: [
          {
            nodeId: "node_01KS8ABYE3Y9RV4NMF35YXCXX9",
            displayName: "host-b",
            endpoint: "wss://172.30.20.51:39207/v1/hub",
            trustState: "trusted",
            authState: "authenticated",
            model: "gpt-5.4",
          },
          {
            nodeId: "node_01OTHER000000000000000000",
            displayName: "lab-node",
            endpoint: "wss://192.168.1.44:4444/v1/hub",
            trustState: "untrusted",
            authState: "not_attempted",
          },
        ],
      },
      theme
    );

    expect(lines[0]).toContain("onclave peers");
    expect(lines[0]).toContain("host-a");
    expect(lines[1]).toContain("host-b");
    expect(lines[1]).toContain("gpt-5.4");
    expect(lines[1]).toContain("trusted/auth");
    expect(lines[1]).toContain("172.30.20.51:39207");
    expect(lines[2]).toContain("lab-node");
    expect(lines[2]).toContain("untrusted/seen");
    expect(lines[2]).toContain("192.168.1.44:4444");
    expect(lines.at(-1)).toContain("┛");
  });

  it("renders an empty-state panel when no peers are available", () => {
    const lines = renderOnclavePeerWidget(40, { localLabel: "host-a", peers: [] }, theme);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("no peers discovered");
  });
});

describe("formatPeerState", () => {
  it("maps trust and auth states to compact widget labels", () => {
    expect(formatPeerState({ trustState: "trusted", authState: "authenticated" })).toBe("trusted/auth");
    expect(formatPeerState({ trustState: "trusted", authState: "not_attempted" })).toBe("trusted/seen");
    expect(formatPeerState({ trustState: "untrusted", authState: "not_attempted" })).toBe("untrusted/seen");
    expect(formatPeerState({ trustState: "auth_failed", authState: "failed" })).toBe("auth_failed");
  });
});
