import {
  fromAmqpMessage,
  mayTriggerTurn,
  type AmqpConsumedMessage,
  type DelegationGrant,
  type Envelope,
} from "@onclave/envelope";
import type { AdapterAuditEventName, AdapterAuditMetadata } from "./audit";
import type { SeenIds } from "./dedup";

export type DeliveryDecision = "ack" | "reject";

export type BudgetCheckResult = {
  deliver: boolean;
  reason?: string;
};

export type DelegationCheckResult =
  | { ok: true; grant: DelegationGrant }
  | { ok: false; reason: string };

// Every side effect is injected so the decision path is fully unit-testable.
// deliverTurn is reachable only from the request/query branch; inform,
// failure, and not_understood are structurally unable to reach it.
export type DeliveryDeps = {
  localHost: string;
  seen: SeenIds;
  isAutoAcceptedHost: (host: string) => Promise<boolean>;
  confirmRemote: (envelope: Envelope) => Promise<boolean>;
  recordExchange: (envelope: Envelope) => Promise<BudgetCheckResult>;
  verifyDelegation: (envelope: Envelope) => Promise<DelegationCheckResult>;
  deliverTurn: (envelope: Envelope) => void;
  deliverDelegatedTurn: (envelope: Envelope, grant: DelegationGrant) => void;
  deliverInert: (envelope: Envelope) => void;
  publishFailureReply: (envelope: Envelope, reason: string) => void;
  publishNotUnderstood: (replyTo: string, error: string) => void;
  registerInbound: (envelope: Envelope) => void;
  acceptReply: (envelope: Envelope) => boolean;
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>;
};

export async function handleInboundMessage(
  deps: DeliveryDeps,
  message: AmqpConsumedMessage
): Promise<DeliveryDecision> {
  const parsed = fromAmqpMessage(message);
  if (!parsed.ok) {
    return handleMalformed(deps, message, parsed.error);
  }
  const envelope = parsed.envelope;
  if (!deps.seen.add(envelope.id)) {
    await deps.audit("message_deduplicated", { message_id: envelope.id });
    return "ack";
  }
  if (mayTriggerTurn(envelope.performative)) {
    return handleTurnCandidate(deps, envelope);
  }
  return handleInert(deps, envelope);
}

async function handleMalformed(
  deps: DeliveryDeps,
  message: AmqpConsumedMessage,
  error: string
): Promise<DeliveryDecision> {
  const target = replyToFromProperties(message);
  if (target !== undefined) {
    deps.publishNotUnderstood(target, error);
  }
  await deps.audit("message_rejected", { detail: error });
  return "reject";
}

function replyToFromProperties(message: AmqpConsumedMessage): string | undefined {
  const properties = message.properties as { replyTo?: unknown };
  return typeof properties.replyTo === "string" && properties.replyTo !== ""
    ? properties.replyTo
    : undefined;
}

async function handleInert(deps: DeliveryDeps, envelope: Envelope): Promise<DeliveryDecision> {
  const correlated = deps.acceptReply(envelope);
  if (correlated) {
    await deps.audit("reply_received", {
      message_id: envelope.id,
      in_reply_to: envelope.in_reply_to,
      conversation_id: envelope.conversation_id,
      performative: envelope.performative,
    });
  }
  deps.deliverInert(envelope);
  await deps.audit("message_delivered_inert", {
    message_id: envelope.id,
    performative: envelope.performative,
    from_agent_id: envelope.from.agent_id,
  });
  return "ack";
}

async function handleTurnCandidate(deps: DeliveryDeps, envelope: Envelope): Promise<DeliveryDecision> {
  const authorization = await authorizeTurn(deps, envelope);
  if (!authorization.deliver) return "ack";
  if (!(await passesBudget(deps, envelope))) return "ack";
  deps.registerInbound(envelope);
  deliverAuthorizedTurn(deps, envelope, authorization.delegation);
  await auditTurnDelivery(deps, envelope);
  return "ack";
}

type TurnAuthorization = { deliver: boolean; delegation?: DelegationGrant };

async function authorizeTurn(
  deps: DeliveryDeps,
  envelope: Envelope
): Promise<TurnAuthorization> {
  if (envelope.delegation !== undefined) return authorizeDelegation(deps, envelope);
  if (envelope.from.host === deps.localHost) return { deliver: true };
  return { deliver: await confirmCrossHost(deps, envelope) };
}

async function authorizeDelegation(
  deps: DeliveryDeps,
  envelope: Envelope
): Promise<TurnAuthorization> {
  const verified = await deps.verifyDelegation(envelope);
  if (!verified.ok) {
    deps.publishFailureReply(envelope, `delegation_rejected:${verified.reason}`);
    await deps.audit("delegation_rejected", {
      message_id: envelope.id,
      grant_id: envelope.delegation?.grant_id,
      reason: verified.reason,
    });
    return { deliver: false };
  }
  await deps.audit("delegation_accepted", {
    message_id: envelope.id,
    grant_id: verified.grant.grant_id,
    from_agent_id: envelope.from.agent_id,
  });
  return { deliver: true, delegation: verified.grant };
}

async function passesBudget(deps: DeliveryDeps, envelope: Envelope): Promise<boolean> {
  const budget = await deps.recordExchange(envelope);
  if (budget.deliver) return true;
  await deps.audit("message_budget_blocked", {
    message_id: envelope.id,
    conversation_id: envelope.conversation_id,
    reason: budget.reason ?? "budget",
  });
  return false;
}

function deliverAuthorizedTurn(
  deps: DeliveryDeps,
  envelope: Envelope,
  delegation?: DelegationGrant
): void {
  if (delegation === undefined) deps.deliverTurn(envelope);
  else deps.deliverDelegatedTurn(envelope, delegation);
}

async function auditTurnDelivery(deps: DeliveryDeps, envelope: Envelope): Promise<void> {
  await deps.audit("message_delivered_turn", {
    message_id: envelope.id,
    performative: envelope.performative,
    conversation_id: envelope.conversation_id,
    from_agent_id: envelope.from.agent_id,
    from_host: envelope.from.host,
  });
}

async function confirmCrossHost(deps: DeliveryDeps, envelope: Envelope): Promise<boolean> {
  if (await deps.isAutoAcceptedHost(envelope.from.host)) {
    return true;
  }
  await deps.audit("remote_confirm_prompted", {
    message_id: envelope.id,
    from_host: envelope.from.host,
    from_agent_id: envelope.from.agent_id,
  });
  const confirmed = await deps.confirmRemote(envelope);
  if (confirmed) return true;
  deps.publishFailureReply(envelope, "declined_by_operator");
  await deps.audit("remote_confirm_declined", {
    message_id: envelope.id,
    from_host: envelope.from.host,
  });
  return false;
}
