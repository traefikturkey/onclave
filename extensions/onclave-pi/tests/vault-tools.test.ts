import { describe, expect, it, vi } from "vitest";
import { createVaultToolDefinitions } from "../src/lib/vault-tools";

describe("Onclave vault tools", () => {
  it("is discoverable without resolving credentials or making requests", () => {
    const client = vi.fn();
    const tools = createVaultToolDefinitions({ client });
    expect(tools.map((tool) => tool.name)).toEqual(["onclave_vault_search", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs"]);
    expect(client).not.toHaveBeenCalled();
  });

  it("resolves a dynamic endpoint only when a tool executes", async () => {
    const endpoint = vi.fn(() => { throw new Error("endpoint sentinel"); });
    const tool = createVaultToolDefinitions({ endpoint }).find((item) => item.name === "onclave_vault_search")!;
    expect(endpoint).not.toHaveBeenCalled();
    await expect((tool.execute as Function)("call", { query: "test" })).rejects.toThrow("endpoint sentinel");
    expect(endpoint).toHaveBeenCalledOnce();
  });

  it("passes cancellation and bounds search output", async () => {
    const signal = AbortSignal.timeout(1000);
    const search = vi.fn(async (_args: unknown, received: AbortSignal) => { expect(received).toBe(signal); return { results: [{ title: "ok" }], total: 1 }; });
    const tool = createVaultToolDefinitions({ client: async () => ({ search } as never) }).find((item) => item.name === "onclave_vault_search")!;
    const result = await (tool.execute as Function)("call", { query: "test", limit: 5 }, signal);
    expect(search).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ total: 1 });
  });

  it("maps content and job action variants with cancellation and validates required arguments", async () => {
    const signal = AbortSignal.timeout(1000);
    const client = async () => ({
      listContent: vi.fn(async (args: unknown, received: AbortSignal) => { expect(received).toBe(signal); return { items: [], total: 0, ...args as object }; }),
      findByVideoId: vi.fn(async (_id: string, received: AbortSignal) => { expect(received).toBe(signal); return { id: "c", metadata: {} }; }),
      channel: vi.fn(async () => ({ source: "youtube", videos: [] })),
      createAnnotation: vi.fn(async () => ({ id: "a", parent_content_id: "c", text: "note" })),
      listAnnotations: vi.fn(async () => []),
      jobStats: vi.fn(async () => ({ pending: 1 })),
    } as never);
    const content = createVaultToolDefinitions({ client }).find((item) => item.name === "onclave_vault_content")!;
    await (content.execute as Function)("call", { operation: "list", limit: 2 }, signal);
    await (content.execute as Function)("call", { operation: "find_video_id", video_id: "vid" }, signal);
    await (content.execute as Function)("call", { operation: "channel", channel: "UC1" }, signal);
    await (content.execute as Function)("call", { operation: "create_annotation", content_id: "c", text: "note" }, signal);
    const jobs = createVaultToolDefinitions({ client }).find((item) => item.name === "onclave_vault_jobs")!;
    const stats = await (jobs.execute as Function)("call", { operation: "stats" }, signal);
    expect(stats.details).toEqual({ pending: 1 });
    await expect((content.execute as Function)("call", { operation: "list_annotations" }, signal)).rejects.toThrow("requires content_id");
    await expect((content.execute as Function)("call", { operation: "create_annotation", content_id: "c" }, signal)).rejects.toThrow("text");
  });

  it("returns useful ingest job identity and validates job operations", async () => {
    const ingest = vi.fn(async () => ({ content_id: "content-1", job_id: "job-1", content_type: "youtube", title: "T" }));
    const client = async () => ({ ingest } as never);
    const tool = createVaultToolDefinitions({ client }).find((item) => item.name === "onclave_vault_ingest")!;
    const result = await (tool.execute as Function)("call", { url: "https://example.test/video" });
    expect(result.details).toEqual({ content_id: "content-1", job_id: "job-1", status: "pending" });
    const jobs = createVaultToolDefinitions({ client: async () => ({}) as never }).find((item) => item.name === "onclave_vault_jobs")!;
    await expect((jobs.execute as Function)("call", { operation: "cancel" })).rejects.toThrow("requires job_id");
  });
});
