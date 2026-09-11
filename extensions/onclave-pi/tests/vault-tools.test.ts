import { describe, expect, it, vi } from "vitest";
import { createVaultToolDefinitions } from "../src/lib/vault-tools";

describe("Onclave vault tools", () => {
  it("is discoverable without resolving credentials or making requests", () => {
    const client = vi.fn();
    const tools = createVaultToolDefinitions({ client });
    expect(tools.map((tool) => tool.name)).toEqual(["onclave_vault_search", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs"]);
    expect(client).not.toHaveBeenCalled();
  });

  it("passes cancellation and bounds search output", async () => {
    const signal = AbortSignal.timeout(1000);
    const search = vi.fn(async (_args: unknown, received: AbortSignal) => { expect(received).toBe(signal); return { results: [{ title: "ok" }], total: 1 }; });
    const tool = createVaultToolDefinitions({ client: async () => ({ search } as never) }).find((item) => item.name === "onclave_vault_search")!;
    const result = await (tool.execute as Function)("call", { query: "test", limit: 5 }, signal);
    expect(search).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ total: 1 });
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
