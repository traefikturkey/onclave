import { describe, expect, it, vi } from "vitest";
import { createEnvelope } from "@onclave/envelope";
import { OnclaveHttpClient, resolveApiBase } from "../src/lib/http-client";
import type { RequestSigner } from "../src/lib/http-signer";

const signer: RequestSigner = {
  keyId: "SHA256:0123456789abcdef",
  signRequest: vi.fn(() => ({
    "signature-input": "sig1=(\"@method\");keyid=\"SHA256:0123456789abcdef\";alg=\"ed25519\";created=1",
    signature: "sig1=:signature:",
  })),
};

function envelope() {
  return createEnvelope({
    performative: "inform",
    from: { agent_id: "sender", name: "Sender", host: "host-a" },
    to: "receiver",
    body: "hello",
  });
}

describe("OnclaveHttpClient", () => {
  it.each([
    ["an origin base", "https://onclave.example/"],
    ["an /api/v1 base", "https://onclave.example/api/v1"],
  ])("uses the four exact signed HTTPS API operations with %s", async (_label, apiBase) => {
    const outbound = envelope();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, message_id: outbound.id }), { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new OnclaveHttpClient({
      apiBase,
      signer,
      fetchFn,
    });

    await expect(client.call({ op: "list_agents" })).resolves.toEqual({ ok: true });
    await expect(client.publish(outbound)).resolves.toBeUndefined();
    await expect(client.next("receiver", 25_000)).resolves.toBeUndefined();
    await expect(client.dispose("delivery/id", "ack")).resolves.toBeUndefined();

    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://onclave.example/api/v1/agents/rpc",
      "https://onclave.example/api/v1/agents/messages",
      "https://onclave.example/api/v1/agents/messages/next?agent_id=receiver&wait_ms=25000",
      "https://onclave.example/api/v1/agents/messages/delivery%2Fid",
    ]);
    expect(signer.signRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/agents/messages/next?agent_id=receiver&wait_ms=25000",
      "onclave.example",
      undefined
    );
  });

  it("validates delivery envelopes and returns API failures to the transport", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ delivery_id: "d-1", envelope: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Agent not found" }), { status: 404 }));
    const client = new OnclaveHttpClient({ apiBase: "http://127.0.0.1:8080", signer, fetchFn });

    await expect(client.next("missing", 0)).rejects.toThrow("invalid envelope");
    await expect(client.call({ op: "list_agents" })).rejects.toThrow("Onclave API request failed (404): Agent not found");
  });
});

describe("resolveApiBase", () => {
  it("canonicalizes an origin or /api/v1 base and prefers --onclave-url", () => {
    expect(resolveApiBase("https://flag.example", { ONCLAVE_API_BASE: "https://env.example" })).toBe(
      "https://flag.example/api/v1/"
    );
    expect(resolveApiBase(undefined, { ONCLAVE_API_BASE: "https://env.example/api/v1" })).toBe(
      "https://env.example/api/v1/"
    );
  });

  it("rejects ambiguous API base paths and unavailable or insecure configuration", () => {
    expect(() => resolveApiBase(undefined, { ONCLAVE_API_BASE: "https://env.example/api" })).toThrow(
      "must be an origin or end in /api/v1"
    );
    expect(() => resolveApiBase(undefined, {})).toThrow("ONCLAVE_API_BASE is required");
    expect(() => resolveApiBase("http://localhost:8080", {})).toThrow("ONCLAVE_API_BASE must use https");
  });
});
