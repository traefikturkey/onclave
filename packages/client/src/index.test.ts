import { describe, expect, it, vi } from "vitest";
import { OnclaveApiError, OnclaveClient, type RequestSigner } from "./index";

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
    await client.getTranscript("c"); await client.reindexEmbeddings("c"); await client.cancelJob("j"); await client.channel("UC 1", 5);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost/api/v1/content/c/download", "http://localhost/api/v1/content/c/reindex-embeddings", "http://localhost/api/v1/jobs/j/cancel", "http://localhost/api/v1/youtube/channel?channel=UC+1&limit=5",
    ]);
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
