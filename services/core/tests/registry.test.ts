import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentCard } from "@onclave/envelope";
import { Registry } from "../src/registry";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onclave-registry-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const card: AgentCard = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "host-1",
  project: "onclave",
  transport: "amqp",
};

function makeRegistry(now: () => Date, path?: string): Registry {
  return new Registry({ path: path ?? join(dir, "registry.json"), staleMs: 1000, now });
}

describe("Registry", () => {
  it("registers, lists, and unregisters agents", async () => {
    const registry = makeRegistry(() => new Date("2026-07-18T10:00:00Z"));
    await registry.register(card);
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ agent_id: "agent-a", alive: true });
    expect(await registry.unregister("agent-a")).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(await registry.unregister("agent-a")).toBe(false);
  });

  it("marks agents stale after missed heartbeats", async () => {
    let currentMs = Date.parse("2026-07-18T10:00:00Z");
    const registry = makeRegistry(() => new Date(currentMs));
    await registry.register(card);
    currentMs += 5000;
    expect(registry.list()[0].alive).toBe(false);
    expect(await registry.heartbeat("agent-a")).toBe(true);
    expect(registry.list()[0].alive).toBe(true);
  });

  it("rejects heartbeats for unknown agents", async () => {
    const registry = makeRegistry(() => new Date());
    expect(await registry.heartbeat("ghost")).toBe(false);
  });

  it("preserves registered_at across re-registration", async () => {
    let currentMs = Date.parse("2026-07-18T10:00:00Z");
    const registry = makeRegistry(() => new Date(currentMs));
    const first = await registry.register(card);
    currentMs += 60000;
    const second = await registry.register({ ...card, name: "Agent A2" });
    expect(second.registered_at).toBe(first.registered_at);
    expect(second.heartbeat_at).not.toBe(first.heartbeat_at);
    expect(second.name).toBe("Agent A2");
  });

  it("persists agents across instances", async () => {
    const path = join(dir, "registry.json");
    const registry = makeRegistry(() => new Date(), path);
    await registry.register(card);
    const reloaded = makeRegistry(() => new Date(), path);
    expect(await reloaded.load()).toBe(1);
    expect(reloaded.get("agent-a")).toMatchObject({ agent_id: "agent-a" });
  });

  it("loads nothing from a missing or corrupt file", async () => {
    const registry = makeRegistry(() => new Date(), join(dir, "missing.json"));
    expect(await registry.load()).toBe(0);
  });
});
