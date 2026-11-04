import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { OnclaveClient } from "@onclave/client";
import type { ArchiveUploader } from "../src/lib/archive-uploader";
import { createArchiveToolDefinitions, registerArchiveTools } from "../src/lib/archive-tools";

type Result = { content: { type: string; text: string }[]; structuredContent: { operation: string; data?: Record<string, unknown>; error?: string }; isError?: boolean };
type Tool = { name: string; exposure: string; parameters: Parameters<typeof Value.Check>[0]; outputSchema: Parameters<typeof Value.Check>[0]; execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Result> };
const id = "a".repeat(64);
function fixture() {
  const client = {
    listArchiveManifests: vi.fn(async () => ({ items: [], next_after: null })),
    getArchiveManifest: vi.fn(async () => ({ id, byte_length: 7, created_at: "2026-01-01T00:00:00Z", chunks: [], source: { source_type: "sessions", uploader_machine_id: "machine", profile: "default", source_path: "sessions/a.jsonl", origin_machine_id: null, session_id: null, project: null, parent_session_id: null } })),
    downloadArchive: vi.fn(async () => Buffer.from([0xe2, 0x98])), // deliberately split UTF8
    searchArchive: vi.fn(async () => ({ matches: [{ offset: 3, preview: "hit" }], next_offset: 4194304, byte_length: 9000000 })),
    uploadArchiveChunk: vi.fn(), commitArchiveManifest: vi.fn(),
  };
  const uploader = { status: vi.fn(() => ({ running: true })), sync: vi.fn(() => ({ running: true })) };
  const options = { client: () => client as unknown as OnclaveClient, uploader: () => uploader as unknown as ArchiveUploader };
  const tool = createArchiveToolDefinitions(options)[0] as unknown as Tool;
  return { client, uploader, options, tool };
}

async function execute(tool: Tool, params: Record<string, unknown>): Promise<Result> {
  const output = await tool.execute("call", params);
  expect(Value.Check(tool.outputSchema, output.structuredContent)).toBe(true);
  expect(JSON.parse(output.content[0]!.text)).toEqual(output.structuredContent);
  return output;
}

describe("onclave_archive", () => {
  it("registers a deferred tool without resolving a client or doing network IO", () => {
    const client = vi.fn();
    const registerTool = vi.fn();
    registerArchiveTools({ registerTool } as never, { client, uploader: () => undefined });
    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: "onclave_archive", exposure: "deferred" });
    expect(client).not.toHaveBeenCalled();
  });

  it("paginates list metadata and retrieves manifests without calling archive writes", async () => {
    const { tool, client } = fixture();
    await execute(tool, { operation: "list", source_type: "sessions", uploader_machine_id: "machine", profile: "default", source_path: "sessions/x.jsonl", session_id: "session", project: "project", after: "cursor", limit: 100000 });
    expect(client.listArchiveManifests).toHaveBeenCalledWith({ source_type: "sessions", uploader_machine_id: "machine", profile: "default", source_path: "sessions/x.jsonl", session_id: "session", project: "project", after: "cursor", limit: 100 }, expect.any(AbortSignal));
    await execute(tool, { operation: "get", id });
    expect(client.getArchiveManifest).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect(client.uploadArchiveChunk).not.toHaveBeenCalled();
    expect(client.commitArchiveManifest).not.toHaveBeenCalled();
  });

  it("returns exact base64 bytes and absolute offsets, with a small default page and explicit EOF", async () => {
    const { tool, client } = fixture();
    const first = await execute(tool, { operation: "read", id, offset: 1 });
    expect(client.downloadArchive).toHaveBeenCalledWith(id, { offset: 1, limit: 65536 }, expect.any(AbortSignal));
    expect(first.structuredContent.data).toEqual({ id, offset: 1, byte_length: 7, bytes_returned: 2, next_offset: 3, data_base64: "4pg=", utf8: "�" });
    const last = await execute(tool, { operation: "read", id, offset: 5, limit: 1048576 });
    expect(last.structuredContent.data?.next_offset).toBeNull();
    expect(Buffer.from(String(first.structuredContent.data?.data_base64), "base64")).toEqual(Buffer.from([0xe2, 0x98]));
  });

  it("labels search as bounded to one manifest window and preserves continuation", async () => {
    const { tool, client } = fixture();
    const output = await execute(tool, { operation: "search", id, q: "hit", offset: 4096 });
    expect(client.searchArchive).toHaveBeenCalledWith(id, { q: "hit", offset: 4096 }, expect.any(AbortSignal));
    expect(output.structuredContent.data).toMatchObject({ bounded: true, scope: "single_manifest_window", offset: 4096, next_offset: 4194304 });
    expect(client.uploadArchiveChunk).not.toHaveBeenCalled();
    expect(client.commitArchiveManifest).not.toHaveBeenCalled();
  });

  it("reports status offline and schedules sync without awaiting uploads", async () => {
    const { tool, uploader, client } = fixture();
    expect((await execute(tool, { operation: "status" })).structuredContent.data).toEqual({ running: true });
    expect((await execute(tool, { operation: "sync" })).structuredContent.data).toEqual({ scheduled: true, running: true });
    expect(uploader.sync).toHaveBeenCalledOnce();
    expect(client.uploadArchiveChunk).not.toHaveBeenCalled();
    expect(client.commitArchiveManifest).not.toHaveBeenCalled();
  });

  it("returns matching typed failures offline or cancelled, never falls back to arbitrary local reads", async () => {
    const tool = createArchiveToolDefinitions({ client: () => undefined, uploader: () => undefined })[0] as unknown as Tool;
    const unavailable = await execute(tool, { operation: "read", id });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent.error).toContain("offline");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tool.execute("call", { operation: "get", id }, controller.signal);
    expect(cancelled.isError).toBe(true);
    expect(Value.Check(tool.parameters, { operation: "read", id, offset: -1 })).toBe(false);
    expect(Value.Check(tool.parameters, { operation: "read", id, limit: 1048577 })).toBe(false);
  });
});
