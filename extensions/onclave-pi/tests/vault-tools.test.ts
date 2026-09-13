import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVaultToolDefinitions, MAX_DOWNLOAD_BYTES } from "../src/lib/vault-tools";
import { OnclaveClient, type RequestSigner } from "@onclave/client";

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
    const jobs = createVaultToolDefinitions({ client }).find((item) => item.name === "onclave_vault_jobs")!;
    const stats = await (jobs.execute as Function)("call", { operation: "stats" }, signal);
    expect(stats.details).toEqual({ pending: 1 });
    await expect((content.execute as Function)("call", { operation: "list_annotations" }, signal)).rejects.toThrow("requires content_id");
    await expect((content.execute as Function)("call", { operation: "create_annotation", content_id: "c" }, signal)).rejects.toThrow("text");
  });

  it("returns useful ingest job identity and validates job operations", async () => {
    const ingest = vi.fn(async () => ({ content_id: "content-1", job_id: "job-1", content_type: "youtube", title: "T" }));
    const client = async () => ({ ingest } as never);
    const tool = createVaultToolDefinitions({ client, notifyAgentId: () => "pi-test" }).find((item) => item.name === "onclave_vault_ingest")!;
    const result = await (tool.execute as Function)("call", { url: "https://example.test/video" });
    expect(ingest).toHaveBeenCalledWith({ url: "https://example.test/video", notify_agent_id: "pi-test" }, expect.anything());
    expect(result.details).toEqual({ content_id: "content-1", job_id: "job-1", status: "pending" });
    const jobs = createVaultToolDefinitions({ client: async () => ({}) as never }).find((item) => item.name === "onclave_vault_jobs")!;
    await expect((jobs.execute as Function)("call", { operation: "cancel" })).rejects.toThrow("requires job_id");
  });

  it("fails ingest clearly when no notification agent is available", async () => {
    const ingest = vi.fn();
    const tool = createVaultToolDefinitions({ client: async () => ({ ingest } as never) }).find((item) => item.name === "onclave_vault_ingest")!;
    await expect((tool.execute as Function)("call", { url: "https://example.test/video" })).rejects.toThrow("requires a connected runtime agent");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("streams a large download to a private opaque file without returning content", async () => {
    const signal = AbortSignal.timeout(1000);
    const payload = Buffer.from("transcript-secret-".repeat(2_000), "utf8");
    const downloadContent = vi.fn(async (contentId: string, received: AbortSignal) => {
      expect(contentId).toBe("content/with/unsafe\\nname");
      expect(received).toBe(signal);
      return new Response(payload, { headers: { "content-length": String(payload.length) } });
    });
    const tool = createVaultToolDefinitions({ client: async () => ({ downloadContent } as never) }).find((item) => item.name === "onclave_vault_content")!;

    const result = await (tool.execute as Function)("call", { operation: "download", content_id: "content/with/unsafe\\nname" }, signal);
    const details = result.details as { local_path: string; content_id: string; bytes: number };
    expect(details).toEqual({ local_path: expect.any(String), content_id: "content/with/unsafe\\nname", bytes: payload.length });
    expect(await readFile(details.local_path)).toEqual(payload);
    expect(basename(details.local_path)).toMatch(/^download-[0-9a-f]{36}\.bin$/);
    expect(details.local_path).not.toContain("unsafe");
    expect(result.content[0].text).not.toContain(payload.toString("utf8"));
    if (process.platform !== "win32") {
      expect((await stat(details.local_path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(details.local_path))).mode & 0o777).toBe(0o700);
    }
    await rm(dirname(details.local_path), { recursive: true, force: true });
  });

  it("rejects download parameters other than operation and content_id", async () => {
    const downloadContent = vi.fn();
    const tool = createVaultToolDefinitions({ client: async () => ({ downloadContent } as never) }).find((item) => item.name === "onclave_vault_content")!;
    await expect((tool.execute as Function)("call", { operation: "download", content_id: "c", transcript: true })).rejects.toThrow("only accepts operation and content_id");
    expect(downloadContent).not.toHaveBeenCalled();
  });

  it("times out a stalled download body and cleans up its private temporary directory", async () => {
    const before = await privateTempEntries();
    const signer: RequestSigner = { keyId: "test", signRequest: vi.fn(() => ({ signature: "sig", "signature-input": "input" })) };
    const fetchFn = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); } })));
    const client = new OnclaveClient({ endpoint: "http://localhost/api/v1", signer, fetchFn, timeoutMs: 20 });
    const tool = createVaultToolDefinitions({ client: async () => client }).find((item) => item.name === "onclave_vault_content")!;
    await expect((tool.execute as Function)("call", { operation: "download", content_id: "stalled" })).rejects.toThrow("deadline");
    expect(await privateTempEntries()).toEqual(before);
  });

  it("cleans the private file and directory when a download is cancelled", async () => {
    const before = await privateTempEntries();
    const controller = new AbortController();
    let pulls = 0;
    const downloadContent = vi.fn(async (_contentId: string, signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(Buffer.from("secret chunk")); },
      pull(stream) {
        pulls += 1;
        if (pulls < 2) return;
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => { stream.error(signal.reason); resolve(); }, { once: true }));
      },
    })));
    const tool = createVaultToolDefinitions({ client: async () => ({ downloadContent } as never) }).find((item) => item.name === "onclave_vault_content")!;
    const operation = (tool.execute as Function)("call", { operation: "download", content_id: "cancel-me" }, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 0);
    await expect(operation).rejects.toThrow();
    expect(await privateTempEntries()).toEqual(before);
  });

  it.each([
    ["upstream error", async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.error(new Error("upstream failed")); } }))],
    ["declared oversize", async () => new Response(new Uint8Array([1]), { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } })],
  ])("cleans up after %s", async (_name, makeResponse) => {
    const before = await privateTempEntries();
    const downloadContent = vi.fn(async () => makeResponse());
    const tool = createVaultToolDefinitions({ client: async () => ({ downloadContent } as never) }).find((item) => item.name === "onclave_vault_content")!;
    await expect((tool.execute as Function)("call", { operation: "download", content_id: "error-case" })).rejects.toThrow();
    expect(await privateTempEntries()).toEqual(before);
  });
});
