import { describe, expect, it } from "bun:test";
import {
  LocalAgentRegistry,
  type LocalAgentRegistration,
} from "../src/lib/local-registry";

const NOW = "2026-05-21T00:00:00.000Z";

describe("LocalAgentRegistry", () => {
  it("registers a local Pi instance", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
    const registration = createRegistration({ name: "agent-one" });

    const agent = registry.register(registration, NOW);

    expect(agent).toMatchObject({
      ...registration,
      status: "online",
      queueDepth: 0,
      contextUsedPct: 0,
      registeredAt: NOW,
      lastSeenAt: NOW,
    });
    expect(registry.list()).toEqual([agent]);
  });

  it("upserts an existing session while preserving registeredAt", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
    registry.register(createRegistration({ name: "agent-one" }), NOW);

    const updated = registry.register(
      createRegistration({ name: "renamed-agent", model: "new-model" }),
      "2026-05-21T00:00:10.000Z"
    );

    expect(updated.name).toBe("renamed-agent");
    expect(updated.model).toBe("new-model");
    expect(updated.registeredAt).toBe(NOW);
    expect(updated.lastSeenAt).toBe("2026-05-21T00:00:10.000Z");
    expect(registry.list()).toHaveLength(1);
  });

  it("updates heartbeat telemetry", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
    registry.register(createRegistration(), NOW);

    const agent = registry.heartbeat("session-1", {
      now: "2026-05-21T00:00:05.000Z",
      queueDepth: 3,
      contextUsedPct: 42,
      model: "updated-model",
    });

    expect(agent).toMatchObject({
      sessionId: "session-1",
      queueDepth: 3,
      contextUsedPct: 42,
      model: "updated-model",
      status: "online",
      lastSeenAt: "2026-05-21T00:00:05.000Z",
    });
  });

  it("returns null when heartbeating an unknown session", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });

    expect(
      registry.heartbeat("missing", {
        now: NOW,
        queueDepth: 0,
        contextUsedPct: 0,
      })
    ).toBeNull();
  });

  it("marks stale agents and removes offline agents during cleanup", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
    registry.register(createRegistration({ sessionId: "stale-session" }), NOW);
    registry.register(createRegistration({ sessionId: "offline-session" }), NOW);
    registry.heartbeat("stale-session", {
      now: "2026-05-21T00:00:20.000Z",
      queueDepth: 0,
      contextUsedPct: 0,
    });

    const result = registry.cleanup("2026-05-21T00:01:01.000Z");

    expect(result.stale).toEqual(["stale-session"]);
    expect(result.removed).toEqual(["offline-session"]);
    expect(registry.get("stale-session")?.status).toBe("stale");
    expect(registry.get("offline-session")).toBeNull();
  });

  it("unregisters a local Pi instance", () => {
    const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
    registry.register(createRegistration(), NOW);

    expect(registry.unregister("session-1")).toBe(true);
    expect(registry.unregister("session-1")).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

function createRegistration(
  overrides: Partial<LocalAgentRegistration> = {}
): LocalAgentRegistration {
  return {
    sessionId: "session-1",
    instanceId: "pi-instance-1",
    name: "agent-one",
    projectLabel: "onclave@main",
    model: "test-model",
    purpose: "testing",
    color: "#336699",
    explicit: false,
    deliveryEndpoint: "local://session-1",
    ...overrides,
  };
}
