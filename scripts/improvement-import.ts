import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOnclaveClient, resolveEndpoint, type ImprovementDraft, type OnclaveClient } from "../packages/client/src/index";

export type ImportRecord = ImprovementDraft & { provenance: Record<string, unknown> };
type Source = { relativePath: string; kind: ImprovementDraft["kind"]; split: "aif-apr" | "record" | "whole" };
type ParsedPiece = { id: string; body: string; sourceId?: string };

const SOURCES: Source[] = [
  { relativePath: "skills/agent-process/references/instruction-feedback.md", kind: "feedback", split: "aif-apr" },
  { relativePath: "skills/agent-process/references/failure-log.md", kind: "failure", split: "aif-apr" },
  { relativePath: "skills/tool-call-analysis/references/analysis-log.md", kind: "analysis", split: "record" },
  { relativePath: "skills/tool-call-analysis/references/classification-feedback.md", kind: "classification", split: "record" },
];

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function sectionId(relativePath: string, heading: string, occurrence = 1): string {
  const legacyId = heading.match(/\b(?:AIF|APR|TCA|TCF)-[A-Za-z0-9-]+\b/i)?.[0];
  const headingText = legacyId === undefined ? heading : heading.replace(legacyId, "");
  const headingSlug = headingText.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
  return `pi-improvement:${relativePath}#${legacyId ? `${legacyId}-${headingSlug}` : headingSlug}${occurrence > 1 ? `-${occurrence}` : ""}`;
}

export function splitMarkdown(relativePath: string, text: string, split: Source["split"]): ParsedPiece[] {
  const lines = text.split(/(?<=\n)/);
  const headingPattern = split === "aif-apr" ? /^##\s+(?=.*\b(?:AIF|APR)-)/ : /^##\s+(?=.*\b(?:TCA|TCF)-)/;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (headingPattern.test(lines[i])) starts.push(i);
  if (starts.length === 0) return [{ id: sectionId(relativePath, "document"), body: text }];
  const result: ParsedPiece[] = [];
  if (starts[0] > 0) result.push({ id: sectionId(relativePath, "preamble"), body: lines.slice(0, starts[0]).join("") });
  const occurrences = new Map<string, number>();
  for (let i = 0; i < starts.length; i++) {
    const end = starts[i + 1] ?? lines.length;
    const body = lines.slice(starts[i], end).join("");
    const heading = lines[starts[i]].replace(/^##\s+/, "").trim();
    const base = sectionId(relativePath, heading);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const sourceId = heading.match(/\b(?:AIF|APR|TCA|TCF)-[A-Za-z0-9-]+\b/i)?.[0];
    result.push({ id: sectionId(relativePath, heading, occurrence), body, ...(sourceId === undefined ? {} : { sourceId }) });
  }
  return result;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

export async function inventory(sourceRoot: string): Promise<ImportRecord[]> {
  const root = path.resolve(sourceRoot);
  const records: ImportRecord[] = [];
  const sources = [...SOURCES];
  for (const fullPath of await markdownFiles(path.join(root, "skills/agent-process/references/knowledge"))) sources.push({ relativePath: path.relative(root, fullPath).split(path.sep).join("/"), kind: "knowledge", split: "whole" });
  for (const fullPath of await markdownFiles(path.join(root, "skills/tool-call-analysis/references/reviews"))) sources.push({ relativePath: path.relative(root, fullPath).split(path.sep).join("/"), kind: "review", split: "whole" });
  for (const source of sources) {
    const raw = await readFile(path.join(root, source.relativePath), "utf8");
    const pieces = source.split === "whole" ? [{ id: sectionId(source.relativePath, "document"), body: raw }] : splitMarkdown(source.relativePath, raw, source.split);
    const fileHash = sha256(raw);
    for (const piece of pieces) records.push({ id: piece.id, kind: source.kind, body: piece.body, source_ids: [piece.sourceId ?? piece.id], source_paths: [source.relativePath], provenance: { import: { importer: "onclave-improvement-import", import_context: "explicit-source-root", source_sha256: fileHash, imported_content_sha256: sha256(piece.body) } } });
  }
  return records;
}

export async function applyImport(client: Pick<OnclaveClient, "createImprovement" | "getImprovement">, records: ImportRecord[]): Promise<void> {
  for (const draft of records) {
    await client.createImprovement(draft);
    const stored = await client.getImprovement(draft.id);
    if (stored.id !== draft.id || stored.kind !== draft.kind || stored.body !== draft.body || JSON.stringify(stored.source_ids) !== JSON.stringify(draft.source_ids) || JSON.stringify(stored.source_paths) !== JSON.stringify(draft.source_paths) || JSON.stringify(stored.provenance) !== JSON.stringify(draft.provenance)) throw new Error(`Stored improvement verification failed for ${draft.id}`);
  }
}

async function main(args: string[]): Promise<void> {
  let sourceRoot: string | undefined;
  let apply = false;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-root") sourceRoot = args[++i];
    else if (args[i] === "--apply") apply = true;
    else if (args[i] === "--verbose") verbose = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!sourceRoot) throw new Error("--source-root is required (use the active default Pi profile root, never legacy)");
  const records = await inventory(sourceRoot);
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  const ids = records.map(({ id }) => id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", total: records.length, by_kind: Object.fromEntries([...counts].sort()), duplicate_id_count: duplicates.length, ...(verbose ? { ids, duplicate_ids: duplicates } : {}) }, null, 2));
  if (duplicates.length > 0) throw new Error(`Importer generated ${duplicates.length} duplicate record IDs`);
  if (apply) await applyImport(await createOnclaveClient({ endpoint: resolveEndpoint(undefined) }), records);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Import failed"); process.exitCode = 1; });
