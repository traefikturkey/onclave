export type LocalAgentStatus = "online" | "stale" | "offline";

export type LocalAgentRegistration = {
  sessionId: string;
  instanceId: string;
  name: string;
  projectLabel: string;
  model: string;
  purpose: string;
  color: string;
  explicit: boolean;
  deliveryEndpoint: string;
};

export type LocalAgent = LocalAgentRegistration & {
  status: LocalAgentStatus;
  queueDepth: number;
  contextUsedPct: number;
  registeredAt: string;
  lastSeenAt: string;
};

export type HeartbeatInput = {
  now: string;
  queueDepth: number;
  contextUsedPct: number;
  model?: string;
};

export type RegistryCleanupResult = {
  stale: string[];
  removed: string[];
};

export type LocalAgentRegistryOptions = {
  staleAfterMs: number;
  offlineAfterMs: number;
};

export class LocalAgentRegistry {
  private readonly agents = new Map<string, LocalAgent>();

  constructor(private readonly options: LocalAgentRegistryOptions) {
    if (options.staleAfterMs <= 0) throw new Error("staleAfterMs must be positive");
    if (options.offlineAfterMs <= options.staleAfterMs) {
      throw new Error("offlineAfterMs must be greater than staleAfterMs");
    }
  }

  register(registration: LocalAgentRegistration, now: string): LocalAgent {
    assertRegistration(registration);
    const existing = this.agents.get(registration.sessionId);
    const agent: LocalAgent = {
      ...registration,
      status: "online",
      queueDepth: existing?.queueDepth ?? 0,
      contextUsedPct: existing?.contextUsedPct ?? 0,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
    };
    this.agents.set(registration.sessionId, agent);
    return agent;
  }

  heartbeat(sessionId: string, input: HeartbeatInput): LocalAgent | null {
    const existing = this.agents.get(sessionId);
    if (!existing) return null;

    const agent: LocalAgent = {
      ...existing,
      model: input.model ?? existing.model,
      status: "online",
      queueDepth: clampNonNegativeInteger(input.queueDepth),
      contextUsedPct: clampPercent(input.contextUsedPct),
      lastSeenAt: input.now,
    };
    this.agents.set(sessionId, agent);
    return agent;
  }

  cleanup(now: string): RegistryCleanupResult {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error(`invalid cleanup timestamp: ${now}`);

    const stale: string[] = [];
    const removed: string[] = [];

    for (const [sessionId, agent] of this.agents) {
      const lastSeenMs = Date.parse(agent.lastSeenAt);
      if (Number.isNaN(lastSeenMs)) {
        this.agents.delete(sessionId);
        removed.push(sessionId);
        continue;
      }

      const ageMs = nowMs - lastSeenMs;
      if (ageMs > this.options.offlineAfterMs) {
        this.agents.delete(sessionId);
        removed.push(sessionId);
        continue;
      }

      if (ageMs > this.options.staleAfterMs && agent.status !== "stale") {
        this.agents.set(sessionId, { ...agent, status: "stale" });
        stale.push(sessionId);
      }
    }

    return { stale, removed };
  }

  unregister(sessionId: string): boolean {
    return this.agents.delete(sessionId);
  }

  get(sessionId: string): LocalAgent | null {
    return this.agents.get(sessionId) ?? null;
  }

  list(): LocalAgent[] {
    return [...this.agents.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
}

function assertRegistration(registration: LocalAgentRegistration): void {
  const requiredStringFields: Array<keyof LocalAgentRegistration> = [
    "sessionId",
    "instanceId",
    "name",
    "projectLabel",
    "model",
    "color",
    "deliveryEndpoint",
  ];
  for (const field of requiredStringFields) {
    if (typeof registration[field] !== "string" || registration[field].length === 0) {
      throw new Error(`local agent registration requires ${field}`);
    }
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(registration.color)) {
    throw new Error("local agent registration color must be #RRGGBB");
  }
}

function clampNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(value)));
}
