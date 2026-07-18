import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// JSONL audit writer with sensitive-field rejection, ported from v1
// onclave-comms audit.ts with core-service event names.
export type AuditEventName =
  | "core_start"
  | "core_stop"
  | "agent_register"
  | "agent_register_rejected"
  | "agent_unregister"
  | "agent_heartbeat_stale"
  | "conversation_exchange"
  | "conversation_budget_advisory"
  | "conversation_terminated"
  | "dead_letter_received"
  | "dead_letter_unparseable"
  | "dead_letter_advisory_sent"
  | "rpc_rejected"
  | "trust_loaded";

export type AuditMetadata = Record<string, unknown>;

const SENSITIVE_FIELD_RE = /(?:prompt|response|body|private|secret|token|password|credential|key_material)/i;

export async function appendAuditEvent(
  path: string,
  event: AuditEventName,
  metadata: AuditMetadata = {}
): Promise<void> {
  assertNoSensitiveFields(metadata);
  await mkdir(dirname(path), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...metadata,
  };
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertNoSensitiveFields(value: unknown, path = "$."): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoSensitiveFields(value[index], `${path}[${index}].`);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      throw new Error(`sensitive audit field is not allowed: ${path}${key}`);
    }
    assertNoSensitiveFields(nested, `${path}${key}.`);
  }
}
