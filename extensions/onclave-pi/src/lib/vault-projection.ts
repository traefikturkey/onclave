import type { JsonObject } from "@onclave/client";

/** Fields deliberately exposed by the model-facing single-item view. */
export const VAULT_FIELDS = [
  "id", "content_type", "title", "description", "mime_type", "file_size",
  "tags", "created_at", "updated_at", "processing_status", "summary",
  "structured_summary", "outline", "summary_coverage", "filtering",
  "quality_tier", "quality_score", "pipeline_tags", "topics", "entities",
] as const;

export type VaultField = typeof VAULT_FIELDS[number] | `metadata.${string}`;

// Keep the default small and stable. Callers wanting the outline, canonical
// summary, or full metadata can request fields explicitly or opt into full.
export const VAULT_COMPACT_FIELDS = [
  "id", "content_type", "title", "processing_status", "summary",
  "summary_coverage", "filtering", "tags", "pipeline_tags", "topics", "entities",
  "metadata.resource_key", "metadata.video_id", "metadata.channel_id",
  "metadata.channel_title", "metadata.published_at", "metadata.duration_seconds",
] as const;

const FIELD_SET = new Set<string>(VAULT_FIELDS);
const FILE_PATH = "file_path";

type ProjectionInput = {
  fields?: string | readonly string[];
  full?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(item: Record<string, unknown>, field: string): unknown {
  if (!field.startsWith("metadata.")) return item[field];
  const metadata = item.metadata;
  if (!isRecord(metadata)) return undefined;
  return field.slice("metadata.".length).split(".").reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, metadata);
}

function validField(field: string): boolean {
  return FIELD_SET.has(field) || (field.startsWith("metadata.") && field.length > "metadata.".length && field.split(".").slice(1).every((part) => part !== ""));
}

/** Project one get response without fetching, downloading, or mutating it. */
export function projectVaultContent(content: JsonObject, options: ProjectionInput = {}): JsonObject {
  if (options.fields !== undefined && options.full === true) throw new Error("fields and full cannot be used together");
  const requested = options.fields === undefined
    ? [...VAULT_COMPACT_FIELDS]
    : (typeof options.fields === "string" ? [options.fields] : [...options.fields]);
  const invalid = [...new Set(requested.filter((field) => !validField(field)))].sort();
  if (invalid.length > 0) throw new Error(`unsupported fields: ${invalid.join(", ")}`);
  const fields = options.full === true
    ? Object.keys(content).filter((field) => field !== FILE_PATH).sort()
    : [...new Set(requested)].sort((left, right) => {
      const leftRank = VAULT_FIELDS.indexOf(left as typeof VAULT_FIELDS[number]);
      const rightRank = VAULT_FIELDS.indexOf(right as typeof VAULT_FIELDS[number]);
      if (leftRank !== -1 && rightRank !== -1) return leftRank - rightRank;
      if (leftRank !== -1) return -1;
      if (rightRank !== -1) return 1;
      return left.localeCompare(right);
    });
  const result: JsonObject = {};
  for (const field of fields) {
    const value = valueAt(content, field);
    if (field.startsWith("metadata.")) {
      if (value !== undefined) {
        const metadata = isRecord(result.metadata) ? result.metadata : {};
        let target = metadata;
        const parts = field.slice("metadata.".length).split(".");
        for (const part of parts.slice(0, -1)) {
          const child = isRecord(target[part]) ? target[part] : {};
          target[part] = child;
          target = child;
        }
        target[parts.at(-1)!] = value;
        result.metadata = metadata;
      }
    } else if (value !== undefined) result[field] = value;
  }
  return result;
}