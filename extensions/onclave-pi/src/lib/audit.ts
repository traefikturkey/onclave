import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEventName =
  | "hub_start"
  | "hub_stop"
  | "local_register"
  | "local_unregister"
  | "discovery_seen"
  | "discovery_ignored"
  | "peer_stale"
  | "auth_attempt"
  | "auth_success"
  | "auth_failure"
  | "trust_loaded"
  | "trust_changed"
  | "message_outbound"
  | "message_inbound"
  | "message_delivered"
  | "response_outbound"
  | "response_inbound"
  | "message_timeout";

export type AuditMetadata = Record<string, unknown>;

const SENSITIVE_FIELD_RE = /(?:prompt|response|private|secret|token|password|credential|key_material)/i;

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
