import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVaultToolDefinitions } from "../src/lib/vault-tools";

const PRIVATE_TEMP_PREFIX = "onclave-pi-vault-";
async function privateTempEntries(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(PRIVATE_TEMP_PREFIX));
}

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
    const jobs = createVaultToolDefinitions({ client: async () => ({ jobStats: vi.fn(async () => ({ pending: 1 })) }) as never }).find((item) => item.name === "onclave_vault_jobs")!;
    const stats = await (jobs.execute as Function)("call", { operation: "stats" }, signal);
    expect(stats.details).toEqual({ pending: 1 });
    await expect((content.execute as Function)("call", { operation: "list_annotations" }, signal)).rejects.toThrow("requires content_id");
    await expect((content.execute as Function)("call", { operation: "create_annotation", content_id: "c" }, signal)).rejects.toThrow("text");
  });

  it("returns useful ingest identity and requires identity for ingest and reprocess", async () => {
    const ingest = vi.fn(async () => ({ content_id: "content-1", job_id: "job-1", content_type: "youtube", title: "T" }));
    const reprocess = vi.fn(async () => ({ content_id: "c", job_id: "j" }));
    const client = async () => ({ ingest, reprocess } as never);
    const tool = createVaultToolDefinitions({ client, notifyAgentId: () => "pi-test" }).find((item) => item.name === "onclave_vault_ingest")!;
    const result = await (tool.execute as Function)("call", { url: "https://example.test/video" });
    expect(ingest).toHaveBeenCalledWith({ url: "https://example.test/video", notify_agent_id: "pi-test" }, expect.anything());
    expect(result.details).toEqual({ content_id: "content-1", job_id: "job-1", status: "pending" });
    const jobs = createVaultToolDefinitions({ client, notifyAgentId: () => "pi-test" }).find((item) => item.name === "onclave_vault_jobs")!;
    await (jobs.execute as Function)("call", { operation: "reprocess", content_id: "c" });
    expect(reprocess).toHaveBeenCalledWith("c", false, undefined, "pi-test");
    const disconnected = createVaultToolDefinitions({ client: async () => ({ ingest, reprocess: vi.fn() } as never) }).find((item) => item.name === "onclave_vault_jobs")!;
    await expect((disconnected.execute as Function)("call", { operation: "reprocess", content_id: "c" })).rejects.toThrow("requires a connected runtime agent");
  });

  it("downloads a complete transcript to a private opaque file without returning content", async () => {
    const signal = AbortSignal.timeout(1000);
    const payload = Buffer.from("transcript-secret-".repeat(2_000), "utf8");
    const getContent = vi.fn(async () => ({ id: "content/unsafe", content_type: "youtube", file_path: "youtube/video/transcript.txt" }));
    const getObject = vi.fn(async (objectKey: string, received: AbortSignal) => {
      expect(objectKey).toBe("youtube/video/transcript.txt");
      expect(received).toBe(signal);
      return new Response(payload, { headers: { "content-length": String(payload.length) } });
    });
    const tool = createVaultToolDefinitions({ client: async () => ({ getContent } as never), s3: async () => ({ getObject } as never) }).find((item) => item.name === "onclave_vault_content")!;
    const result = await (tool.execute as Function)("call", { operation: "transcript", content_id: "content/unsafe" }, signal);
    const details = result.details as { local_path: string; content_id: string; bytes: number };
    expect(details).toEqual({ local_path: expect.any(String), content_id: "content/unsafe", bytes: payload.length });
    expect(await readFile(details.local_path)).toEqual(payload);
    expect(basename(details.local_path)).toMatch(/^download-[0-9a-f]{36}\.bin$/);
    expect(result.content[0].text).not.toContain(payload.toString("utf8"));
    if (process.platform !== "win32") {
      expect((await stat(details.local_path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(details.local_path))).mode & 0o777).toBe(0o700);
    }
    await rm(dirname(details.local_path), { recursive: true, force: true });
  });

  it("keeps the old download operation as an in-memory compatibility alias", async () => {
    const getContent = vi.fn(async () => ({ id: "c", content_type: "youtube", file_path: "youtube/c/transcript.txt" }));
    const downloadContent = vi.fn(async () => new Response("compatibility transcript"));
    const tool = createVaultToolDefinitions({ client: async () => ({ getContent, downloadContent } as never) }).find((item) => item.name === "onclave_vault_content")!;
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    expect(prepare({ operation: "download", content_id: "c" })).toEqual({ operation: "transcript", content_id: "c" });
    const result = await (tool.execute as Function)("call", { operation: "download", content_id: "c" });
    expect(result.details.bytes).toBe("compatibility transcript".length);
  });

  it("downloads objects larger than the former local size gate", async () => {
    const before = await privateTempEntries();
    const payload = new Uint8Array(50 * 1024 * 1024 + 1);
    const getContent = vi.fn(async () => ({ id: "large", content_type: "youtube", file_path: "youtube/large/transcript.txt" }));
    const getObject = vi.fn(async () => new Response(payload));
    const tool = createVaultToolDefinitions({ client: async () => ({ getContent } as never), s3: async () => ({ getObject } as never) }).find((item) => item.name === "onclave_vault_content")!;
    const result = await (tool.execute as Function)("call", { operation: "transcript", content_id: "large" });
    expect(result.details.bytes).toBe(payload.byteLength);
    await rm(dirname(result.details.local_path), { recursive: true, force: true });
    expect(await privateTempEntries()).toEqual(before);
  });

  it("cleans the private file and directory when a download is cancelled", async () => {
    const before = await privateTempEntries();
    const controller = new AbortController();
    let pulls = 0;
    const getContent = vi.fn(async () => ({ id: "cancel-me", content_type: "youtube", file_path: "youtube/cancel/transcript.txt" }));
    const getObject = vi.fn(async (_key: string, signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(Buffer.from("secret chunk")); },
      pull(stream) {
        pulls += 1;
        if (pulls < 2) return;
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => { stream.error(signal.reason); resolve(); }, { once: true }));
      },
    })));
    const tool = createVaultToolDefinitions({ client: async () => ({ getContent } as never), s3: async () => ({ getObject } as never) }).find((item) => item.name === "onclave_vault_content")!;
    const operation = (tool.execute as Function)("call", { operation: "transcript", content_id: "cancel-me" }, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 0);
    await expect(operation).rejects.toThrow();
    expect(await privateTempEntries()).toEqual(before);
  });

  it("cleans up after an upstream error", async () => {
    const before = await privateTempEntries();
    const getContent = vi.fn(async () => ({ id: "error-case", content_type: "youtube", file_path: "youtube/error/transcript.txt" }));
    const getObject = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.error(new Error("upstream failed")); } })));
    const tool = createVaultToolDefinitions({ client: async () => ({ getContent } as never), s3: async () => ({ getObject } as never) }).find((item) => item.name === "onclave_vault_content")!;
    await expect((tool.execute as Function)("call", { operation: "transcript", content_id: "error-case" })).rejects.toThrow();
    expect(await privateTempEntries()).toEqual(before);
  });
});
