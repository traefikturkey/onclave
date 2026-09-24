export type LogLevel = "debug" | "info" | "warn" | "error";

type JsonLogValue = string | number | boolean | null | JsonLogValue[] | { [key: string]: JsonLogValue };

const RESERVED_FIELDS = new Set(["ts", "level", "event"]);
const SENSITIVE_FIELD = /(?:authorization|body|cookie|credential|input|message|password|payload|prompt|request|response|secret|signature|token|url)/i;
const URL_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

function safeEvent(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,127}$/.test(value) ? value : "invalid_event";
}

function safeError(error: Error): JsonLogValue {
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : "Error";
  const result: { [key: string]: JsonLogValue } = { name };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) result.code = code;
  return result;
}

function sanitizeValue(value: unknown, key: string, depth: number, seen: WeakSet<object>): JsonLogValue | undefined {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return URL_VALUE.test(value) ? "[REDACTED_URL]" : value.slice(0, 500);
  if (typeof value !== "object") return undefined;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (value instanceof Error) return safeError(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 4) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonLogValue[] = [];
      for (const item of value.slice(0, 50)) {
        const sanitized = sanitizeValue(item, "", depth + 1, seen);
        if (sanitized !== undefined) result.push(sanitized);
      }
      return result;
    }
    const result: { [key: string]: JsonLogValue } = {};
    for (const field of Object.keys(value).slice(0, 50)) {
      if (RESERVED_FIELDS.has(field) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(field)) continue;
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[field];
      } catch {
        continue;
      }
      const sanitized = sanitizeValue(item, field, depth + 1, seen);
      if (sanitized !== undefined) result[field] = sanitized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, JsonLogValue> {
  const result: Record<string, JsonLogValue> = {};
  const seen = new WeakSet<object>();
  for (const key of Object.keys(fields).slice(0, 100)) {
    if (RESERVED_FIELDS.has(key) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
    let value: unknown;
    try {
      value = fields[key];
    } catch {
      continue;
    }
    const sanitized = sanitizeValue(value, key, 0, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const safeLevel: LogLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
  const line = JSON.stringify({
    ...sanitizeFields(fields),
    ts: new Date().toISOString(),
    level: safeLevel,
    event: safeEvent(event),
  });
  if (safeLevel === "error" || safeLevel === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}
