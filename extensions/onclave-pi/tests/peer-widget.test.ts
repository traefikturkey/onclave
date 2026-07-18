import { describe, expect, it } from "vitest";
import { formatPeerState, renderOnclavePeerWidget } from "../src/lib/peer-widget";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

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

    const normalized = lines.map(stripAnsi);

    expect(normalized[0]).toContain("onclave");
    expect(normalized[0]).not.toContain("onclave peers");
    expect(normalized[0]).toContain("host-a");
    expect(normalized[0]).not.toContain(" ━host-a");
    expect(normalized[0]).toContain("━ host-a ━┓");
    expect(normalized[1]).toContain("●");
    expect(normalized[1]).toContain("host-b");
    expect(normalized[1]).toContain("gpt-5.4");
    expect(normalized[1]).toContain("trusted/auth");
    expect(normalized[1]).toContain("172.30.20.51:39207");
    expect(normalized[2]).toContain("◆");
    expect(normalized[2]).toContain("lab-node");
    expect(normalized[2]).toContain("untrusted/seen");
    expect(normalized[2]).toContain("192.168.1.44:4444");
    expect(normalized.at(-1)).toContain("┛");
  });

  it("does not truncate the model name when there is enough width", () => {
    const lines = renderOnclavePeerWidget(
      150,
      {
        localLabel: "host-a",
        peers: [
          {
            nodeId: "node_01KS8ABYE3Y9RV4NMF35YXCXX9",
            displayName: "agent-dev1",
            endpoint: "wss://172.30.20.50:41047/v1/hub",
            trustState: "trusted",
            authState: "authenticated",
            model: "claude-sonnet-4.6",
          },
        ],
      },
      theme
    );

    const normalized = stripAnsi(lines[1]);
    expect(normalized).toContain("claude-sonnet-4.6");
    expect(normalized).not.toContain("claude-sonnet…");
  });

  it("renders configured static peers separately from live discovered peers", () => {
    const lines = renderOnclavePeerWidget(
      72,
      {
        localLabel: "host-a",
        peers: [
          {
            nodeId: "node_01STATIC000000000000000000",
            displayName: "base-ops",
            endpoint: "wss://172.30.10.20:64993/v1/hub",
            trustState: "stale",
            authState: "not_attempted",
            source: "static",
          },
        ],
      },
      theme
    );

    const normalized = lines.map(stripAnsi);
    expect(normalized[1]).toContain("~");
    expect(normalized[1]).toContain("base-ops");
    expect(normalized[1]).toContain("configured");
    expect(normalized[1]).toContain("172.30.10.20:64993");
  });

  it("renders an empty-state panel when no peers are available", () => {
    const lines = renderOnclavePeerWidget(40, { localLabel: "host-a", peers: [] }, theme);

    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1])).toContain("no peers configured or discovered");
  });
});

describe("formatPeerState", () => {
  it("maps trust and auth states to compact widget labels", () => {
    expect(formatPeerState({ trustState: "trusted", authState: "authenticated" })).toBe("trusted/auth");
    expect(formatPeerState({ trustState: "trusted", authState: "not_attempted" })).toBe("trusted/seen");
    expect(formatPeerState({ trustState: "untrusted", authState: "not_attempted" })).toBe("untrusted/seen");
    expect(formatPeerState({ trustState: "auth_failed", authState: "failed" })).toBe("auth_failed");
    expect(formatPeerState({ trustState: "stale", authState: "not_attempted", source: "static" })).toBe("configured");
  });
});
