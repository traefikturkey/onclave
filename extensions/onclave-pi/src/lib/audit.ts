import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// JSONL audit writer with sensitive-field rejection, ported from v1
// onclave-comms audit.ts with adapter-side event names.
export type AdapterAuditEventName =
  | "adapter_connect"
  | "adapter_disconnect"
  | "adapter_register"
  | "adapter_unregister"
  | "message_delivered_turn"
  | "message_delivered_inert"
  | "message_deduplicated"
  | "message_rejected"
  | "message_budget_blocked"
  | "remote_confirm_prompted"
  | "remote_confirm_declined"
  | "reply_published"
  | "reply_received"
  | "correlation_miss"
  | "inform_published";

export type AdapterAuditMetadata = Record<string, unknown>;

const SENSITIVE_FIELD_RE = /(?:prompt|response|body|private|secret|token|password|credential|key_material)/i;

export async function appendAdapterAuditEvent(
  path: string,
  event: AdapterAuditEventName,
  metadata: AdapterAuditMetadata = {}
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
