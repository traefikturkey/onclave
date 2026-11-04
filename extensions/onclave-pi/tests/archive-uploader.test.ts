import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_CHUNK_BYTES, archiveManifestId, type ArchiveManifest } from "@onclave/client";
import { ArchiveUploader, archiveSourceType } from "../src/lib/archive-uploader";
import { onclaveRuntimeDir, persistentMachineId } from "../src/lib/improvement-tools";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onclave-archive-"));
  temporary.push(root);
  const profileDir = join(root, "default");
  const runtimeDir = join(root, "identity");
  await mkdir(profileDir);
  const chunks = new Map<string, Buffer>();
  const manifests: ArchiveManifest[] = [];
  const client = {
    uploadArchiveChunk: vi.fn(async (bytes: Uint8Array) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      chunks.set(sha256, Buffer.from(bytes));
      return { sha256, size: bytes.length };
    }),
    commitArchiveManifest: vi.fn(async (manifest: ArchiveManifest) => {
      expect(manifest.id).toBe(archiveManifestId(manifest));
      manifests.push(manifest);
      return { ...manifest, created_at: "2026-01-01T00:00:00Z" };
    }),
  };
  const options = { profileDir, runtimeDir, client: () => client, machineId: async () => "uploader-A" };
  const uploader = new ArchiveUploader(options);
  async function file(path: string, data: string | Buffer = '{"partial":') {
    const target = join(profileDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  }
  return { root, profileDir, runtimeDir, chunks, manifests, client, options, uploader, file };
}

function restored(manifest: ArchiveManifest, chunks: Map<string, Buffer>): Buffer {
  return Buffer.concat(manifest.chunks.map((chunk) => chunks.get(chunk.sha256)!));
}

describe("native archive uploader", () => {
  it("uses exactly the approved paths, including nested subagent sessions, and leaves originals untouched", async () => {
    const f = await fixture();
    const allowed = ["sessions/main.jsonl", "sessions/project/subagents/child.jsonl", "bedrock-usage.jsonl", "codex-cache.jsonl", "onclave/v2-audit.jsonl", "runtime/herdr-tab-naming.jsonl"];
    const denied = ["auth.json", "debug.jsonl", "browser/history.jsonl", "cache/a.jsonl", "state/a.jsonl", "onclave/other.jsonl", "runtime/other.jsonl", "sessions/not-json.txt"];
    for (const path of [...allowed, ...denied]) await f.file(path);
    await f.uploader.scan();
    expect(f.manifests.map((m) => m.source.source_path).sort()).toEqual(allowed.sort());
    for (const path of [...allowed, ...denied]) expect(await readFile(join(f.profileDir, path), "utf8")).toBe('{"partial":');
    for (const path of ["../sessions/a.jsonl", "sessions/../auth.jsonl", "/sessions/a.jsonl", "sessions\\x.jsonl", ...denied]) expect(archiveSourceType(path)).toBeUndefined();
    expect(archiveSourceType("sessions/subagents/a.jsonl")).toBe("sessions");
  });

  it("never follows a session directory escape and refuses legacy even if selected as active", async () => {
    const f = await fixture();
    await f.file("sessions/legitimate.jsonl");
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.jsonl"), "not approved");
    await symlink(outside, join(f.profileDir, "sessions", "escape"), "junction");
    await f.uploader.scan();
    expect(f.manifests.map((m) => m.source.source_path)).toEqual(["sessions/legitimate.jsonl"]);
    const legacy = join(f.root, "legacy");
    await mkdir(legacy);
    await expect(new ArchiveUploader({ ...f.options, profileDir: legacy }).scan()).rejects.toThrow("legacy");
  });

  it("streams fixed raw chunks, preserving unknown records, huge lines, partial JSON, and UTF8 bytes", async () => {
    const f = await fixture();
    const original = Buffer.concat([Buffer.from('{"type":"unknown","body":"'), Buffer.alloc(2 * ARCHIVE_CHUNK_BYTES + 71, 0x78), Buffer.from('☃"}\n{"unfinished":"☃')]);
    await f.file("sessions/large.jsonl", original);
    await f.uploader.scan();
    expect(f.manifests).toHaveLength(1);
    const manifest = f.manifests[0]!;
    expect(manifest.chunks.map((c) => c.size)).toEqual([ARCHIVE_CHUNK_BYTES, ARCHIVE_CHUNK_BYTES, original.length - 2 * ARCHIVE_CHUNK_BYTES]);
    expect(restored(manifest, f.chunks).equals(original)).toBe(true);
    expect(manifest.byte_length).toBe(original.length);
  });

  it("supports empty files and keeps unknown historical origin distinct from uploader identity", async () => {
    const f = await fixture();
    await f.file("bedrock-usage.jsonl", "");
    await f.file("sessions/child.jsonl", JSON.stringify({ type: "session", id: "child-session", cwd: "/workspace/project", parentSession: "/old/2026_01234567-89ab-cdef-0123-456789abcdef.jsonl" }) + "\n");
    await f.uploader.scan();
    expect(f.manifests.find((m) => m.source.source_type === "bedrock_usage")?.chunks).toEqual([]);
    expect(f.manifests.find((m) => m.source.source_type === "sessions")?.source).toMatchObject({ uploader_machine_id: "uploader-A", origin_machine_id: null, session_id: "child-session", project: "/workspace/project", parent_session_id: "01234567-89ab-cdef-0123-456789abcdef", parent_source_path: "/old/2026_01234567-89ab-cdef-0123-456789abcdef.jsonl", profile: "default" });
    await f.file("sessions/child.jsonl", JSON.stringify({ type: "session", id: "child-session", parentSession: "/old/unrecognized.jsonl" }) + "\n");
    await f.uploader.scan();
    expect(f.manifests.at(-1)?.source).toMatchObject({ parent_session_id: null, parent_source_path: "/old/unrecognized.jsonl" });
  });

  it("checkpoints only after successful commit and skips a successful unchanged snapshot after restart", async () => {
    const f = await fixture();
    await f.file("sessions/retry.jsonl");
    f.client.commitArchiveManifest.mockRejectedValueOnce(new Error("offline"));
    await f.uploader.scan();
    expect(f.uploader.status()).toMatchObject({ committed: 0, errors: 1, last_error: "offline" });
    expect((await readdir(join(f.runtimeDir, "archive-checkpoints"))).filter((name) => name.endsWith(".json"))).toEqual([]);
    await f.uploader.scan();
    expect(f.manifests).toHaveLength(1);
    expect(f.client.uploadArchiveChunk).toHaveBeenCalledTimes(2);
    const restarted = new ArchiveUploader(f.options);
    await restarted.scan();
    expect(restarted.status().unchanged).toBe(1);
    expect(f.client.uploadArchiveChunk).toHaveBeenCalledTimes(2);
    expect(f.client.commitArchiveManifest).toHaveBeenCalledTimes(2);
    // Checkpoints contain identities and hashes, not a second copy of native content.
    const saved = (await readdir(join(f.runtimeDir, "archive-checkpoints"))).find((name) => name.endsWith(".json"))!;
    expect(await readFile(join(f.runtimeDir, "archive-checkpoints", saved), "utf8")).not.toContain("partial");
  });

  it("serializes concurrent instances of the same source and commits one immutable snapshot", async () => {
    const f = await fixture();
    await f.file("sessions/shared.jsonl");
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      f.client.uploadArchiveChunk.mockImplementationOnce(async (bytes) => {
        resolve();
        await new Promise<void>((r) => { release = r; });
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        return { sha256, size: bytes.length };
      });
    });
    const first = f.uploader.scan();
    await entered;
    const second = new ArchiveUploader(f.options);
    await second.scan();
    expect(second.status().busy).toBe(1);
    release();
    await first;
    expect(f.client.commitArchiveManifest).toHaveBeenCalledTimes(1);
    await second.scan();
    expect(second.status().unchanged).toBe(1);
  });

  it("detects same-path rewrites and rotations, rehashing rather than assuming append-only", async () => {
    const f = await fixture();
    const path = await f.file("sessions/rewrite.jsonl", "original\n");
    await f.uploader.scan();
    await writeFile(path, "rewritten"); // same size and same inode
    await f.uploader.scan();
    await rename(path, `${path}.old`);
    await writeFile(path, "rotated\n");
    await f.uploader.scan();
    expect(f.manifests.map((m) => restored(m, f.chunks).toString())).toEqual(["original\n", "rewritten", "rotated\n"]);
    expect(new Set(f.manifests.map((m) => m.id)).size).toBe(3);
  });

  it("reuses committed prefix chunks on append and yields chunk work fairly across sources", async () => {
    const f = await fixture();
    const first = await f.file("sessions/a.jsonl", Buffer.alloc(ARCHIVE_CHUNK_BYTES, 65));
    await f.file("sessions/b.jsonl", Buffer.alloc(2 * ARCHIVE_CHUNK_BYTES + 1, 66));
    await f.uploader.scan();
    expect(new Set(f.client.uploadArchiveChunk.mock.calls.slice(0, 2).map(([bytes]) => bytes[0]))).toEqual(new Set([65, 66]));
    const calls = f.client.uploadArchiveChunk.mock.calls.length;
    await writeFile(first, Buffer.concat([Buffer.alloc(ARCHIVE_CHUNK_BYTES, 65), Buffer.from("appended")]));
    await f.uploader.scan();
    expect(f.client.uploadArchiveChunk).toHaveBeenCalledTimes(calls + 1);
    expect(restored(f.manifests.at(-1)!, f.chunks).toString().endsWith("appended")).toBe(true);
  });

  it("recovers a dead process claim on restart without losing pending originals", async () => {
    const f = await fixture();
    const path = await f.file("sessions/dead-owner.jsonl", "before");
    await f.uploader.scan();
    const checkpointDir = join(f.runtimeDir, "archive-checkpoints");
    const checkpoint = (await readdir(checkpointDir)).find((name) => name.endsWith(".json"))!;
    const lock = join(checkpointDir, checkpoint.replace(/\.json$/, ".lock"));
    await mkdir(lock);
    await writeFile(join(lock, "2147483647-dead-owner"), "");
    await writeFile(path, "after");
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return realKill(pid, signal);
    });
    try { await new ArchiveUploader(f.options).scan(); } finally { kill.mockRestore(); }
    expect(f.manifests).toHaveLength(2);
    expect(restored(f.manifests.at(-1)!, f.chunks).toString()).toBe("after");
  });

  it("rejects a changing scan without committing a hybrid snapshot, then retries local originals", async () => {
    const f = await fixture();
    const path = await f.file("sessions/changing.jsonl", Buffer.alloc(ARCHIVE_CHUNK_BYTES + 2, 65));
    f.client.uploadArchiveChunk.mockImplementationOnce(async (bytes) => {
      await writeFile(path, Buffer.alloc(ARCHIVE_CHUNK_BYTES + 2, 66));
      return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    });
    await f.uploader.scan();
    expect(f.manifests).toHaveLength(0);
    expect(f.uploader.status().last_error).toContain("changed during reading");
    await f.uploader.scan();
    expect(restored(f.manifests[0]!, f.chunks).equals(Buffer.alloc(ARCHIVE_CHUNK_BYTES + 2, 66))).toBe(true);
  });

  it("cancels between chunks, releases the source lock, and lets another instance retry", async () => {
    const f = await fixture();
    await f.file("sessions/cancel.jsonl", Buffer.alloc(ARCHIVE_CHUNK_BYTES + 1, 65));
    const controller = new AbortController();
    f.client.uploadArchiveChunk.mockImplementationOnce(async (bytes) => {
      controller.abort();
      return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    });
    await expect(f.uploader.scan(controller.signal)).rejects.toThrow();
    expect(f.manifests).toHaveLength(0);
    await new ArchiveUploader(f.options).scan();
    expect(f.manifests).toHaveLength(1);
  });

  it("returns from start without awaiting service work and stops offline without a shutdown request", async () => {
    const f = await fixture();
    await f.file("sessions/offline.jsonl");
    const provider = vi.fn(() => new Promise<never>(() => undefined));
    const offline = new ArchiveUploader({ ...f.options, client: provider });
    expect(offline.start()).toBeUndefined();
    expect(offline.stop()).toBeUndefined();
    expect(f.client.uploadArchiveChunk).not.toHaveBeenCalled();
    expect(f.client.commitArchiveManifest).not.toHaveBeenCalled();
  });

  it("reuses the existing improvement machine identity location", async () => {
    const f = await fixture();
    const one = await persistentMachineId(f.runtimeDir);
    const two = await persistentMachineId(f.runtimeDir);
    expect(two).toBe(one);
    expect(onclaveRuntimeDir(f.profileDir)).toContain("onclave");
    const uploader = new ArchiveUploader({ ...f.options, machineId: undefined });
    await f.file("codex-cache.jsonl");
    await uploader.scan();
    expect(f.manifests[0]?.source.uploader_machine_id).toBe(one);
  });
});
