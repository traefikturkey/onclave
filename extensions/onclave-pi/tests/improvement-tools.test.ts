import { describe, expect, it, vi } from "vitest";
import { createImprovementToolDefinitions } from "../src/lib/improvement-tools";
import type { ImprovementRecord } from "@onclave/client";

function item(id: string, provenance: Record<string, unknown>): ImprovementRecord {
  return { id, kind: "knowledge", body: "Keep this", project: "https://example.test/repo@main", source_ids: [], source_paths: [], provenance, revision: 1 };
}

describe("Onclave improvement tools", () => {
  it("registers a deferred capture/get/search/update contract", () => {
    const tool = createImprovementToolDefinitions({ client: () => undefined })[0];
    expect(tool.name).toBe("onclave_improvement");
    expect(tool.exposure).toBe("deferred");
    expect(tool.outputSchema).toBeDefined();
  });

  it("derives attribution and distinguishes concurrent session captures", async () => {
    const records: ImprovementRecord[] = [];
    const client = { createImprovement: vi.fn(async (draft: { id: string; provenance?: Record<string, unknown> }) => { const saved = item(draft.id, draft.provenance ?? {}); records.push(saved); return saved; }) };
    const tool = createImprovementToolDefinitions({ client: () => client as never, runtimeDir: "unused", machineId: async () => "machine-stable", git: async (_cwd, args) => args[0] === "config" ? "git@github.com:Example/Repo.git\n" : "main\n" })[0];
    const execute = tool.execute as (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: unknown) => Promise<{ details: { item: ImprovementRecord } }>;
    await Promise.all(["session-one", "session-two"].map((session) => execute("call", { operation: "capture", kind: "knowledge", body: "Keep this" }, undefined, undefined, { cwd: "/repo", sessionManager: { getSessionId: () => session } })));
    expect(records).toHaveLength(2);
    expect(records[0]?.id).not.toBe(records[1]?.id);
    expect(records[0]?.provenance).toMatchObject({ machine_id: "machine-stable", session_id: "session-one", repository: { repository: "https://github.com/example/repo", branch: "main", checkout: "/repo" } });
    expect(records[0]?.provenance.process_instance_id).toBe(records[1]?.provenance.process_instance_id);
  });

  it("reports unavailable service as NOT SAVED without local fallback", async () => {
    const tool = createImprovementToolDefinitions({ client: () => undefined })[0];
    const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    const response = await execute("call", { operation: "capture", kind: "note", body: "note" });
    expect(response.content[0]?.text).toContain("NOT SAVED");
    expect(response.details).toMatchObject({ saved: false, error: "service_unavailable" });
  });

  it("preserves revision conflict diagnostics and explicitly rejects stale updates", async () => {
    const tool = createImprovementToolDefinitions({ client: () => ({ updateImprovement: async () => { throw new Error("Onclave API request failed (409): revision_conflict expected_revision=1 current_revision=2"); } } as never) })[0];
    const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    const response = await execute("call", { operation: "update", id: "record", expected_revision: 1, kind: "note", body: "changed" });
    expect(response.content[0]?.text).toContain("revision_conflict");
    expect(response.details.error).toContain("current_revision=2");
  });
});
