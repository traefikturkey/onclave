import { readFile } from "node:fs/promises";
import {
  evaluateBudget,
  mayTriggerTurn,
  type BudgetLimits,
  type Performative,
  type TokenUsage,
} from "@onclave/envelope";
import { atomicWriteJson } from "./state";

export type ConversationStatus = "open" | "terminated";

export type ConversationState = {
  conversation_id: string;
  exchanges: number;
  usage_total: number;
  status: ConversationStatus;
  participants: string[];
  updated_at: string;
};

export type RecordExchangeInput = {
  conversationId: string;
  performative: Performative;
  fromAgentId: string;
  toAgentId: string;
  usage?: TokenUsage;
};

export type RecordExchangeResult =
  | { ok: true; state: ConversationState; advisory?: "token_budget_exceeded" }
  | { ok: false; reason: "exchange_budget_exceeded" | "conversation_terminated"; state: ConversationState };

export type ConversationStoreOptions = {
  path: string;
  limits: BudgetLimits;
  now?: () => Date;
};

export class ConversationStore {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly now: () => Date;

  constructor(private readonly options: ConversationStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.options.path, "utf8"));
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    for (const entry of parsed) {
      const state = entry as ConversationState;
      if (typeof state.conversation_id === "string") {
        this.conversations.set(state.conversation_id, state);
      }
    }
    return this.conversations.size;
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.options.path, [...this.conversations.values()], 0o600);
  }

  private getOrCreate(conversationId: string, participants: string[]): ConversationState {
    const existing = this.conversations.get(conversationId);
    if (existing !== undefined) return existing;
    const created: ConversationState = {
      conversation_id: conversationId,
      exchanges: 0,
      usage_total: 0,
      status: "open",
      participants,
      updated_at: this.now().toISOString(),
    };
    this.conversations.set(conversationId, created);
    return created;
  }

  async recordExchange(input: RecordExchangeInput): Promise<RecordExchangeResult> {
    const state = this.getOrCreate(input.conversationId, [input.fromAgentId, input.toAgentId]);
    if (state.status === "terminated") {
      return { ok: false, reason: "conversation_terminated", state };
    }
    const usageDelta =
      input.usage !== undefined ? input.usage.input_tokens + input.usage.output_tokens : 0;
    const next: ConversationState = {
      ...state,
      exchanges: state.exchanges + (mayTriggerTurn(input.performative) ? 1 : 0),
      usage_total: state.usage_total + usageDelta,
      participants: mergeParticipants(state.participants, input.fromAgentId, input.toAgentId),
      updated_at: this.now().toISOString(),
    };
    const verdict = evaluateBudget(this.options.limits, {
      exchanges: next.exchanges,
      totalTokens: next.usage_total,
    });
    if (!verdict.ok) {
      next.status = "terminated";
      this.conversations.set(next.conversation_id, next);
      await this.persist();
      return { ok: false, reason: verdict.reason, state: next };
    }
    this.conversations.set(next.conversation_id, next);
    await this.persist();
    return { ok: true, state: next, ...(verdict.advisory ? { advisory: verdict.advisory } : {}) };
  }

  get(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId);
  }
}

function mergeParticipants(existing: string[], ...agents: string[]): string[] {
  const merged = new Set(existing);
  for (const agent of agents) merged.add(agent);
  return [...merged];
}
