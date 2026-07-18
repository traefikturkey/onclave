import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore, type RecordExchangeInput } from "../src/conversations";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onclave-conversations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(maxExchanges = 3, maxTotalTokens = 1000, path?: string): ConversationStore {
  return new ConversationStore({
    path: path ?? join(dir, "conversations.json"),
    limits: { maxExchanges, maxTotalTokens },
  });
}

function exchange(overrides: Partial<RecordExchangeInput> = {}): RecordExchangeInput {
  return {
    conversationId: "conv-1",
    performative: "request",
    fromAgentId: "agent-a",
    toAgentId: "agent-b",
    ...overrides,
  };
}

describe("ConversationStore", () => {
  it("counts only turn-triggering performatives as exchanges", async () => {
    const store = makeStore();
    await store.recordExchange(exchange({ performative: "inform" }));
    await store.recordExchange(exchange({ performative: "failure" }));
    const result = await store.recordExchange(exchange({ performative: "query" }));
    expect(result.ok).toBe(true);
    expect(result.state.exchanges).toBe(1);
  });

  it("terminates at the exchange budget", async () => {
    const store = makeStore(2);
    expect((await store.recordExchange(exchange())).ok).toBe(true);
    const second = await store.recordExchange(exchange());
    expect(second).toMatchObject({ ok: false, reason: "exchange_budget_exceeded" });
    expect(second.state.status).toBe("terminated");
  });

  it("rejects exchanges on terminated conversations", async () => {
    const store = makeStore(1);
    await store.recordExchange(exchange());
    const result = await store.recordExchange(exchange());
    expect(result).toMatchObject({ ok: false, reason: "conversation_terminated" });
  });

  it("accumulates token usage and raises the advisory", async () => {
    const store = makeStore(10, 100);
    const first = await store.recordExchange(
      exchange({ usage: { input_tokens: 40, output_tokens: 20 } })
    );
    expect(first).toMatchObject({ ok: true });
    expect("advisory" in first && first.advisory).toBeFalsy();
    const second = await store.recordExchange(
      exchange({ usage: { input_tokens: 30, output_tokens: 10 } })
    );
    expect(second).toMatchObject({ ok: true, advisory: "token_budget_exceeded" });
    expect(second.state.usage_total).toBe(100);
  });

  it("tracks participants across the conversation", async () => {
    const store = makeStore();
    await store.recordExchange(exchange());
    const result = await store.recordExchange(
      exchange({ fromAgentId: "agent-b", toAgentId: "agent-a" })
    );
    expect(result.state.participants.sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("persists conversation state across instances", async () => {
    const path = join(dir, "conversations.json");
    const store = makeStore(3, 1000, path);
    await store.recordExchange(exchange());
    const reloaded = makeStore(3, 1000, path);
    expect(await reloaded.load()).toBe(1);
    expect(reloaded.get("conv-1")).toMatchObject({ exchanges: 1, status: "open" });
  });
});
