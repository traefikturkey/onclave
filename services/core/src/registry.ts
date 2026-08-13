import { readFile } from "node:fs/promises";
import { isAgentCard, type AgentCard } from "@onclave/envelope";
import { atomicWriteJson } from "./state";

export type RegisteredAgent = AgentCard & {
  registered_at: string;
  heartbeat_at: string;
  key_id?: string;
};

export class AgentKeyMismatchError extends Error {
  constructor() {
    super("Agent is bound to a different key");
    this.name = "AgentKeyMismatchError";
  }
}

export type AgentListing = RegisteredAgent & { alive: boolean };

export type RegistryOptions = {
  path: string;
  staleMs: number;
  now?: () => Date;
};

function isRegisteredAgent(value: unknown): value is RegisteredAgent {
  if (!isAgentCard(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.registered_at === "string"
    && typeof record.heartbeat_at === "string"
    && (record.key_id === undefined || typeof record.key_id === "string");
}

export class Registry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly now: () => Date;
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly options: RegistryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.options.path, "utf8");
    } catch {
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    for (const entry of parsed) {
      if (isRegisteredAgent(entry)) {
        this.agents.set(entry.agent_id, entry);
      }
    }
    return this.agents.size;
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.options.path, [...this.agents.values()], 0o600);
  }

  async register(card: AgentCard, keyId?: string): Promise<RegisteredAgent> {
    return this.mutate(async () => {
      const timestamp = this.now().toISOString();
      const existing = this.agents.get(card.agent_id);
      if (keyId !== undefined && existing?.key_id !== undefined && existing.key_id !== keyId) {
        throw new AgentKeyMismatchError();
      }
      const agent: RegisteredAgent = {
        ...card,
        registered_at: existing?.registered_at ?? timestamp,
        heartbeat_at: timestamp,
        ...(keyId === undefined && existing?.key_id === undefined ? {} : { key_id: keyId ?? existing?.key_id }),
      };
      this.agents.set(card.agent_id, agent);
      await this.persist();
      return agent;
    });
  }

  async heartbeat(agentId: string): Promise<boolean> {
    return this.mutate(async () => {
      const agent = this.agents.get(agentId);
      if (agent === undefined) return false;
      this.agents.set(agentId, { ...agent, heartbeat_at: this.now().toISOString() });
      await this.persist();
      return true;
    });
  }

  async unregister(agentId: string): Promise<boolean> {
    return this.mutate(async () => {
      const existed = this.agents.delete(agentId);
      if (existed) await this.persist();
      return existed;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  isAlive(agent: RegisteredAgent): boolean {
    const age = this.now().getTime() - Date.parse(agent.heartbeat_at);
    return age <= this.options.staleMs;
  }

  list(): AgentListing[] {
    return [...this.agents.values()].map((agent) => ({
      ...agent,
      alive: this.isAlive(agent),
    }));
  }
}
