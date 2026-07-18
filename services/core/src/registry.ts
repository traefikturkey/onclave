import { readFile } from "node:fs/promises";
import { isAgentCard, type AgentCard } from "@onclave/envelope";
import { atomicWriteJson } from "./state";

export type RegisteredAgent = AgentCard & {
  registered_at: string;
  heartbeat_at: string;
};

export type AgentListing = RegisteredAgent & { alive: boolean };

export type RegistryOptions = {
  path: string;
  staleMs: number;
  now?: () => Date;
};

function isRegisteredAgent(value: unknown): value is RegisteredAgent {
  if (!isAgentCard(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.registered_at === "string" && typeof record.heartbeat_at === "string";
}

export class Registry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly now: () => Date;

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

  async register(card: AgentCard): Promise<RegisteredAgent> {
    const timestamp = this.now().toISOString();
    const existing = this.agents.get(card.agent_id);
    const agent: RegisteredAgent = {
      ...card,
      registered_at: existing?.registered_at ?? timestamp,
      heartbeat_at: timestamp,
    };
    this.agents.set(card.agent_id, agent);
    await this.persist();
    return agent;
  }

  async heartbeat(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return false;
    this.agents.set(agentId, { ...agent, heartbeat_at: this.now().toISOString() });
    await this.persist();
    return true;
  }

  async unregister(agentId: string): Promise<boolean> {
    const existed = this.agents.delete(agentId);
    if (existed) await this.persist();
    return existed;
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
