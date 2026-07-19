import { createHash } from "node:crypto";
import { isUlid, ulid } from "./ulid";

export const DELEGATION_VERSION = 1;
export const MAX_DELEGATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_DELEGATION_SCOPE_LENGTH = 2_000;

export const DELEGATED_ACTIONS = [
  "read",
  "repo_write",
  "git_commit",
  "git_push",
  "infrastructure_plan",
  "infrastructure_apply",
  "service_mutation",
  "backup_restore",
  "data_migration",
  "consumer_cutover",
] as const;

export type DelegatedAction = (typeof DELEGATED_ACTIONS)[number];

export type DelegationGrant = {
  v: 1;
  grant_id: string;
  issuer_agent_id: string;
  issuer_project?: string;
  audience_agent_id: string;
  audience_project?: string;
  conversation_id: string;
  request_sha256: string;
  actions: DelegatedAction[];
  scope: string;
  issued_at: string;
  expires_at: string;
};

export type CreateDelegationGrantInput = {
  issuerAgentId: string;
  issuerProject?: string;
  audienceAgentId: string;
  audienceProject?: string;
  conversationId: string;
  body: string;
  actions: DelegatedAction[];
  scope: string;
  ttlMs: number;
  now?: () => Date;
  grantId?: string;
};

export type VerifyDelegationGrantInput = {
  grant: DelegationGrant;
  envelope: {
    from: { agent_id: string; project?: string };
    to: string;
    conversation_id: string;
    body: string;
  };
  localAgentId: string;
  localProject?: string;
  now?: () => Date;
};

export type DelegationVerificationResult =
  | { ok: true; grant: DelegationGrant }
  | { ok: false; error: string };

export function createDelegationGrant(input: CreateDelegationGrantInput): DelegationGrant {
  validateCreationInput(input);
  const issuedAt = (input.now ?? (() => new Date()))();
  return {
    v: DELEGATION_VERSION,
    grant_id: input.grantId ?? ulid(),
    issuer_agent_id: input.issuerAgentId,
    audience_agent_id: input.audienceAgentId,
    conversation_id: input.conversationId,
    request_sha256: requestSha256(input.body),
    actions: [...new Set(input.actions)].sort(),
    scope: input.scope,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
    ...(input.issuerProject === undefined ? {} : { issuer_project: input.issuerProject }),
    ...(input.audienceProject === undefined ? {} : { audience_project: input.audienceProject }),
  };
}

export function parseDelegationGrant(value: unknown): DelegationVerificationResult {
  if (!isRecord(value)) return invalid("delegation must be an object");
  const commonError = validateCommonFields(value);
  if (commonError !== undefined) return invalid(commonError);
  const grant = value as DelegationGrant;
  const timingError = validateGrantTiming(grant);
  return timingError === undefined ? { ok: true, grant } : invalid(timingError);
}

export function verifyDelegationGrant(
  input: VerifyDelegationGrantInput
): DelegationVerificationResult {
  const parsed = parseDelegationGrant(input.grant);
  if (!parsed.ok) return parsed;
  const temporalError = validateCurrentTime(parsed.grant, input.now?.() ?? new Date());
  if (temporalError !== undefined) return invalid(temporalError);
  const routingError = validateRouting(parsed.grant, input);
  if (routingError !== undefined) return invalid(routingError);
  if (parsed.grant.request_sha256 !== requestSha256(input.envelope.body)) {
    return invalid("delegation request body does not match grant");
  }
  return { ok: true, grant: parsed.grant };
}

export function isDelegatedAction(value: unknown): value is DelegatedAction {
  return typeof value === "string" && (DELEGATED_ACTIONS as readonly string[]).includes(value);
}

export function requestSha256(body: string): string {
  // #lizard forgives: TS lexer merges the adjacent validation helpers below
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function validateCreationInput(input: CreateDelegationGrantInput): void {
  if (!isUlid(input.conversationId)) throw new Error("delegation conversation id must be a ULID");
  if (!validActions(input.actions)) throw new Error("delegation requires known actions");
  if (input.scope.length === 0 || input.scope.length > MAX_DELEGATION_SCOPE_LENGTH) {
    throw new Error("delegation scope must contain 1-2000 characters");
  }
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 60_000) {
    throw new Error("delegation TTL must be at least 60 seconds");
  }
  if (input.ttlMs > MAX_DELEGATION_LIFETIME_MS) {
    throw new Error("delegation TTL exceeds 24 hours");
  }
}

function validateCommonFields(value: Record<string, unknown>): string | undefined {
  if (value.v !== DELEGATION_VERSION) return "unsupported delegation version";
  if (!isUlid(value.grant_id)) return "delegation grant id must be a ULID";
  if (!isUlid(value.conversation_id)) return "delegation conversation id must be a ULID";
  if (!validIdentityFields(value)) return "delegation identity fields are invalid";
  if (!isHex(value.request_sha256, 64)) return "delegation request hash must be SHA256 hex";
  if (!validActions(value.actions)) return "delegation actions are invalid";
  if (!isBoundedString(value.scope, MAX_DELEGATION_SCOPE_LENGTH)) {
    return "delegation scope is invalid";
  }
  return undefined;
}

function validateGrantTiming(grant: DelegationGrant): string | undefined {
  if (!isTimestamp(grant.issued_at) || !isTimestamp(grant.expires_at)) {
    return "delegation timestamps must be ISO timestamps";
  }
  const lifetime = Date.parse(grant.expires_at) - Date.parse(grant.issued_at);
  if (lifetime <= 0 || lifetime > MAX_DELEGATION_LIFETIME_MS) {
    return "delegation lifetime is invalid";
  }
  return undefined;
}

function validateCurrentTime(grant: DelegationGrant, now: Date): string | undefined {
  if (Date.parse(grant.issued_at) > now.getTime() + 30_000) return "delegation is not yet valid";
  if (Date.parse(grant.expires_at) <= now.getTime()) return "delegation has expired";
  return undefined;
}

function validateRouting(
  grant: DelegationGrant,
  input: VerifyDelegationGrantInput
): string | undefined {
  if (grant.issuer_agent_id !== input.envelope.from.agent_id) {
    return "delegation issuer agent does not match envelope";
  }
  if ((grant.issuer_project ?? undefined) !== (input.envelope.from.project ?? undefined)) {
    return "delegation issuer project does not match envelope";
  }
  if (grant.audience_agent_id !== input.localAgentId || input.envelope.to !== input.localAgentId) {
    return "delegation audience agent does not match receiver";
  }
  if ((grant.audience_project ?? undefined) !== (input.localProject ?? undefined)) {
    return "delegation audience project does not match receiver";
  }
  if (grant.conversation_id !== input.envelope.conversation_id) {
    return "delegation conversation does not match envelope";
  }
  return undefined;
}

function validIdentityFields(value: Record<string, unknown>): boolean {
  return (
    isBoundedString(value.issuer_agent_id, 256) &&
    isBoundedString(value.audience_agent_id, 256) &&
    isOptionalString(value.issuer_project) &&
    isOptionalString(value.audience_project) &&
    isBoundedString(value.issued_at, 100) &&
    isBoundedString(value.expires_at, 100)
  );
}

function validActions(value: unknown): value is DelegatedAction[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= DELEGATED_ACTIONS.length &&
    value.every(isDelegatedAction) &&
    new Set(value).size === value.length
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/i.test(value);
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
