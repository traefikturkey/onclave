import { describe, expect, it, vi } from "vitest";
import { AuthenticatedS3Client, OnclaveApiError, OnclaveClient, type RequestSigner } from "./index";

const signer: RequestSigner = { keyId: "test", signRequest: vi.fn(() => ({ signature: "sig", "signature-input": "input" })) };
function response(body: unknown, status = 200): Response { return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

describe("Onclave vault client", () => {
  it("normalizes endpoint and signs the exact authenticated URL and body", async () => {
    const fetchFn = vi.fn(async () => response({ content_id: "c", content_type: "youtube", title: "T", job_id: "j" }));
    const client = new OnclaveClient({ endpoint: "https://vault.example/api/v1", signer, fetchFn });
    await client.ingest({ url: "https://youtube.com/watch?v=abc" }, { tags: ["test"] });
    expect(fetchFn).toHaveBeenCalledWith("https://vault.example/api/v1/ingest?tags=test", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    expect(signer.signRequest).toHaveBeenCalledWith("POST", "/api/v1/ingest?tags=test", "vault.example", expect.any(Buffer));
  });

  it("maps finite vault operations to their server routes", async () => {
    const fetchFn = vi.fn(async (url: string) => response(url.includes("download") ? "transcript" : url.includes("reindex") ? { content_id: "c", status: "completed", chunk_count: 1, model: "m" } : []));
    const client = new OnclaveClient({ endpoint: "http://localhost/api/v1", signer, fetchFn });
    await client.getTranscript("c"); await client.downloadContent("unsafe/id");
    await client.getTranscript("c", { variant: "analysis" });
    await client.downloadContent("unsafe/id", { variant: "analysis" });
    await client.reindexEmbeddings("c"); await client.cancelJob("j"); await client.channel("UC 1", 5); await client.reprocess("c", true, undefined, "pi-test");
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost/api/v1/content/c/download", "http://localhost/api/v1/content/unsafe%2Fid/download",
      "http://localhost/api/v1/content/c/download?variant=analysis", "http://localhost/api/v1/content/unsafe%2Fid/download?variant=analysis",
      "http://localhost/api/v1/content/c/reindex-embeddings", "http://localhost/api/v1/jobs/j/cancel", "http://localhost/api/v1/youtube/channel?channel=UC+1&limit=5", "http://localhost/api/v1/content/c/reprocess?force=true&notify_agent_id=pi-test",
    ]);
    expect(signer.signRequest).toHaveBeenCalledWith("GET", "/api/v1/content/unsafe%2Fid/download?variant=analysis", "localhost", undefined);
  });

  it("signs improvement capture, get, list, and revision-checked update routes", async () => {
    const saved = { id: "record", kind: "knowledge", body: "fact", project: "repo", source_ids: [], source_paths: [], provenance: { machine_id: "machine" }, revision: 2 };
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response(saved, 201);
      if (init?.method === "PATCH") return response(saved);
      if (url.includes("?")) return response({ items: [saved], total: 1, limit: 5, offset: 0 });
      return response(saved);
    });
    const client = new OnclaveClient({ endpoint: "https://vault.example", signer, fetchFn });
    await client.createImprovement({ id: "record", kind: "knowledge", body: "fact", provenance: { machine_id: "machine" } });
    await client.getImprovement("record/unsafe");
    await client.listImprovements({ q: "durable fact", kind: "knowledge", project: "repo", limit: 5, offset: 10 });
    await client.updateImprovement("record/unsafe", { expected_revision: 2, kind: "knowledge", body: "fact" });
    expect(fetchFn.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://vault.example/api/v1/improvements", "POST"],
      ["https://vault.example/api/v1/improvements/record%2Funsafe", "GET"],
      ["https://vault.example/api/v1/improvements?q=durable+fact&kind=knowledge&project=repo&limit=5&offset=10", "GET"],
      ["https://vault.example/api/v1/improvements/record%2Funsafe", "PATCH"],
    ]);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({ id: "record", kind: "knowledge", body: "fact", provenance: { machine_id: "machine" } });
    expect(JSON.parse(String(fetchFn.mock.calls[3]?.[1]?.body))).toEqual({ expected_revision: 2, kind: "knowledge", body: "fact" });
  });

  it("preserves improvement revision conflict details", async () => {
    const client = new OnclaveClient({ endpoint: "https://vault.example", signer, fetchFn: async () => response({ error: "revision_conflict", expected_revision: 2, current_revision: 3 }, 409) });
    await expect(client.updateImprovement("record", { expected_revision: 2, kind: "note", body: "changed" })).rejects.toThrow("revision_conflict (expected revision 2, current revision 3)");
  });

  it("requires HTTPS for the workstation S3 endpoint while allowing HTTP for core", () => {
    expect(() => new AuthenticatedS3Client({ endpoint: "http://s3.example.internal", bucket: "menos", region: "us-east-1", accessKey: "access-key", secretKey: "secret-key" })).toThrow("https");
    expect(() => new OnclaveClient({ endpoint: "http://core.example.internal", signer })).not.toThrow();
  });

  it("signs the exact encoded S3 path without normalizing dot key segments", async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => new Response("transcript"));
    const client = new AuthenticatedS3Client({ endpoint: "https://s3.example.internal", bucket: "menos", region: "us-east-1", accessKey: "access-key", secretKey: "secret-key", fetchFn });
    const expectedUrl = "https://s3.example.internal/menos/literal/%2E/%2E%2E/tail";
    expect(client.objectUrl("literal/./../tail")).toBe(expectedUrl);
    vi.setSystemTime(new Date("2025-01-02T03:04:05Z"));
    try {
      await client.getObject("literal/./../tail");
    } finally {
      vi.useRealTimers();
    }
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(expectedUrl);
    expect(init?.headers).toMatchObject({ host: "s3.example.internal", authorization: "AWS4-HMAC-SHA256 Credential=access-key/20250102/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=8284202c7eeeb4360dce367b7bb02d5d5333249f44162cb8a1f9770cb53aa9df" });
    expect(JSON.stringify(init?.headers)).not.toContain("secret-key");
  });

  it("returns typed HTTP errors and honors cancellation", async () => {
    const fetchFn = vi.fn(async () => response({ detail: "nope" }, 404));
    const client = new OnclaveClient({ endpoint: "https://vault.example", signer, fetchFn });
    await expect(client.getContent("missing")).rejects.toMatchObject({ name: "OnclaveApiError", status: 404, detail: "nope" });
    expect(() => { throw new OnclaveApiError(400, "bad", "{}"); }).toThrow("bad");
    const controller = new AbortController(); controller.abort();
    await expect(client.getContent("x", controller.signal)).rejects.toThrow();
  });
});
