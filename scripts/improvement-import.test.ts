import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImprovementRecord } from "../packages/client/src/index";
import { applyImport, inventory, splitMarkdown, type ImportRecord } from "./improvement-import";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("improvement import parsing", () => {
  it("preserves the complete preamble and heading-delimited records", () => {
    const text = "# Log\n\nintro\n\n## AIF-1 - First\ncontent\n\n## AIF-2 - Second\nlast\n";
    expect(splitMarkdown("feedback.md", text, "aif-apr")).toEqual([
      { id: "pi-improvement:feedback.md#preamble", body: "# Log\n\nintro\n\n" },
      { id: "pi-improvement:feedback.md#AIF-1-first", body: "## AIF-1 - First\ncontent\n\n", sourceId: "AIF-1" },
      { id: "pi-improvement:feedback.md#AIF-2-second", body: "## AIF-2 - Second\nlast\n", sourceId: "AIF-2" },
    ]);
  });

  it("disambiguates reused legacy IDs while preserving every full heading body and source ID", () => {
    const text = "## AIF-092 - Original record\nfirst body\n\n## AIF-092 - Later correction\nsecond body\n";
    const pieces = splitMarkdown("instruction-feedback.md", text, "aif-apr");
    expect(pieces.map(({ id }) => id)).toEqual([
      "pi-improvement:instruction-feedback.md#AIF-092-original-record",
      "pi-improvement:instruction-feedback.md#AIF-092-later-correction",
    ]);
    expect(pieces.map(({ body }) => body).join("")).toBe(text);
    expect(pieces.map(({ sourceId }) => sourceId)).toEqual(["AIF-092", "AIF-092"]);
    expect(new Set(pieces.map(({ id }) => id)).size).toBe(pieces.length);
  });

  it("keeps unrecognized headings inside the preceding record and handles no-record documents whole", () => {
    expect(splitMarkdown("x.md", "## AIF-1\na\n### detail\nb\n## Notes\nc\n", "aif-apr")).toHaveLength(1);
    expect(splitMarkdown("x.md", "## AIF-1\na\n### detail\nb\n## APR-2\nc\n", "aif-apr").map((part) => part.body)).toEqual(["## AIF-1\na\n### detail\nb\n", "## APR-2\nc\n"]);
  });

  it("inventories source files deterministically with per-document and per-record provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "improvement-import-")); temporary.push(root);
    const dirs = ["skills/agent-process/references/knowledge", "skills/agent-process/references", "skills/tool-call-analysis/references/reviews"];
    for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, "skills/agent-process/references/instruction-feedback.md"), "## AIF-1\nBody\n");
    await writeFile(path.join(root, "skills/agent-process/references/failure-log.md"), "## APR-1\nFailure\n");
    await writeFile(path.join(root, "skills/tool-call-analysis/references/analysis-log.md"), "## TCA-1\nAnalysis\n");
    await writeFile(path.join(root, "skills/tool-call-analysis/references/classification-feedback.md"), "## TCF-1\nClassification\n");
    await writeFile(path.join(root, "skills/agent-process/references/knowledge/note.md"), "# Knowledge\nWhole\n");
    await writeFile(path.join(root, "skills/tool-call-analysis/references/reviews/review.md"), "# Review\nWhole\n");
    const first = await inventory(root);
    expect(await inventory(root)).toEqual(first);
    expect(first).toHaveLength(6);
    expect(first.find((record) => record.kind === "knowledge")?.body).toBe("# Knowledge\nWhole\n");
    expect(first.every((record) => record.source_paths?.length === 1 && typeof record.provenance?.import === "object")).toBe(true);
  });

  it("posts then verifies every exact body and source reference", async () => {
    const store = new Map<string, ImprovementRecord>();
    const client = {
      createImprovement: vi.fn(async (draft: ImportRecord): Promise<ImprovementRecord> => {
        const existing = store.get(draft.id);
        const candidate: ImprovementRecord = {
          id: draft.id,
          kind: draft.kind,
          body: draft.body,
          project: draft.project ?? null,
          source_ids: draft.source_ids ?? [],
          source_paths: draft.source_paths ?? [],
          provenance: draft.provenance ?? {},
          revision: 1,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        };
        if (existing) {
          const existingContent = { id: existing.id, kind: existing.kind, body: existing.body, project: existing.project, source_ids: existing.source_ids, source_paths: existing.source_paths, provenance: existing.provenance };
          const candidateContent = { id: candidate.id, kind: candidate.kind, body: candidate.body, project: candidate.project, source_ids: candidate.source_ids, source_paths: candidate.source_paths, provenance: candidate.provenance };
          if (JSON.stringify(existingContent) !== JSON.stringify(candidateContent)) throw new Error(`Conflict for ${draft.id}`);
          return existing;
        }
        store.set(draft.id, candidate);
        return candidate;
      }),
      getImprovement: vi.fn(async (id: string): Promise<ImprovementRecord> => {
        const record = store.get(id);
        if (!record) throw new Error(`Missing improvement ${id}`);
        return record;
      }),
    }; 
    const record = { id: "stable", kind: "note" as const, body: "exact\nbody", source_ids: ["legacy-id"], source_paths: ["knowledge/a.md"], provenance: { import: { source_sha256: "hash" } } };
    await applyImport(client, [record]);
    expect(client.createImprovement).toHaveBeenCalledWith(record);
    expect(client.getImprovement).toHaveBeenCalledWith("stable");
    expect(store.get("stable")?.body).toBe("exact\nbody");
    expect(client.createImprovement).toHaveBeenCalledTimes(1);
    expect(client.getImprovement).toHaveBeenCalledTimes(1);
    await expect(client.createImprovement({ ...record, body: "different" })).rejects.toThrow("Conflict for stable");
    expect(store.get("stable")?.body).toBe("exact\nbody");
  });
});
