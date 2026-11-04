import { PGlite } from "@electric-sql/pglite";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHIVE_CHUNK_BYTES, ARCHIVE_SEARCH_BYTES, OnclaveApiError, OnclaveClient, archiveManifestId, type ArchiveManifest, type ArchiveSource, type RequestSigner } from "../../../packages/client/src/index";
import { ArchiveRepository, ArchiveService, createArchiveHandlers } from "../src/vault/archive";
import { createVaultHttpServer } from "../src/vault/http";
import { KeyStore, computeKeyId } from "../src/vault/keys";
import type { SqlClient } from "../src/vault/storage";

describe("signed native archive API and canonical client", () => {
  const db = new PGlite();
  const sql: SqlClient = { async query(text, values) {
    const result = await db.query<Record<string, unknown>>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } };
  const repository = new ArchiveRepository({ ...sql, async connect() { return { ...sql, release() {} }; } });
  const objects = new Map<string, Buffer>();
  const service = new ArchiveService(repository, {
    async upload(path, stream) { const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part)); const body = Buffer.concat(parts); objects.set(path, body); return body.length; },
    async download(path) { const bytes = objects.get(path); if (!bytes) throw new Error("missing object"); return bytes; },
  });
  let server: Server;
  let client: OnclaveClient;
  let base: string;
  let keysDir: string;
  const source: ArchiveSource = { source_type: "sessions", uploader_machine_id: "machine-a", profile: "default", source_path: "project/native.jsonl", origin_machine_id: null, session_id: "native-session", project: "/work/onclave", parent_session_id: null, parent_source_path: "old/parent.jsonl" };
  function manifest(bytes: Buffer, overrides: Partial<ArchiveSource> = {}): ArchiveManifest {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += ARCHIVE_CHUNK_BYTES) {
      const body = bytes.subarray(offset, offset + ARCHIVE_CHUNK_BYTES);
      chunks.push({ sha256: createHash("sha256").update(body).digest("hex"), size: body.length });
    }
    const draft = { source: { ...source, ...overrides }, chunks, byte_length: bytes.length };
    return { ...draft, id: archiveManifestId(draft) };
  }
  async function upload(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += ARCHIVE_CHUNK_BYTES) await client.uploadArchiveChunk(bytes.subarray(offset, offset + ARCHIVE_CHUNK_BYTES)); }
  beforeAll(async () => {
    await db.exec(await readFile(new URL("../src/vault/migrations/20260724_native_archive.sql", import.meta.url), "utf8"));
    // Startup migration is additive and rerunnable.
    await db.exec(await readFile(new URL("../src/vault/migrations/20260724_native_archive.sql", import.meta.url), "utf8"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ type: "spki", format: "der" });
    const name = Buffer.from("ssh-ed25519");
    const nameLength = Buffer.alloc(4); nameLength.writeUInt32BE(name.length);
    const keyLength = Buffer.alloc(4); keyLength.writeUInt32BE(32);
    const blob = Buffer.concat([nameLength, name, keyLength, der.subarray(-32)]);
    const signer: RequestSigner = { keyId: computeKeyId(blob), signRequest(method, path, authority, body) {
      const components = ['"@method"', '"@path"', '"@authority"'];
      const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${authority}`];
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers["content-digest"] = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
        components.push('"content-digest"'); lines.push(`"content-digest": ${headers["content-digest"]}`);
      }
      const params = `(${components.join(" ")});keyid="${signer.keyId}";alg="ed25519";created=${Math.floor(Date.now() / 1000)}`;
      lines.push(`"@signature-params": ${params}`);
      return { ...headers, "signature-input": `sig1=${params}`, signature: `sig1=:${sign(null, Buffer.from(lines.join("\n")), privateKey).toString("base64")}:` };
    } };
    keysDir = await mkdtemp(join(tmpdir(), "onclave-archive-"));
    const keyPath = join(keysDir, "authorized_keys");
    await writeFile(keyPath, `ssh-ed25519 ${blob.toString("base64")}\n`);
    server = createVaultHttpServer({ keyStore: new KeyStore(keyPath), handlers: createArchiveHandlers(service) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No TCP address");
    base = `http://127.0.0.1:${address.port}`;
    client = new OnclaveClient({ endpoint: base, signer });
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
    if (keysDir) await rm(keysDir, { recursive: true, force: true });
  });

  it("requires signatures on archive routes", async () => {
    expect((await fetch(`${base}/api/v1/archive/manifests`)).status).toBe(401);
  });
  it("preserves arbitrary bytes including huge partial/unknown records, with complete bounded downloads", async () => {
    const bytes = Buffer.concat([Buffer.from('{"type":"unknown-tree","image":"'), Buffer.alloc(11 * ARCHIVE_CHUNK_BYTES, 97), Buffer.from([0xff, 0, 10])]);
    const snapshot = manifest(bytes);
    await upload(bytes);
    const committed = await client.commitArchiveManifest(snapshot);
    expect(committed.id).toBe(snapshot.id);
    expect(committed.source.origin_machine_id).toBeNull();
    expect((await client.getArchiveManifest(snapshot.id)).chunks).toEqual(snapshot.chunks);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += ARCHIVE_CHUNK_BYTES) parts.push(await client.downloadArchive(snapshot.id, { offset, limit: ARCHIVE_CHUNK_BYTES }));
    expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    expect(await client.downloadArchive(snapshot.id, { offset: bytes.length })).toHaveLength(0);
    await expect(client.downloadArchive(snapshot.id, { limit: ARCHIVE_CHUNK_BYTES + 1 })).rejects.toMatchObject({ status: 400 });
    await client.commitArchiveManifest(snapshot);
    expect((await client.listArchiveManifests({ session_id: source.session_id! })).items.filter((item) => item.id === snapshot.id)).toHaveLength(1);
  });
  it("atomically rejects missing chunks and immutable ID collisions", async () => {
    const missing = manifest(Buffer.from("missing chunk"));
    await expect(client.commitArchiveManifest(missing)).rejects.toMatchObject({ status: 409 });
    await expect(client.getArchiveManifest(missing.id)).rejects.toMatchObject({ status: 404 });
    await expect(repository.registerChunk("0".repeat(64), 1)).resolves.toBeUndefined();
    await expect(repository.registerChunk("0".repeat(64), 2)).rejects.toMatchObject({ status: 409 });
    const snapshot = manifest(Buffer.from("valid"));
    await upload(Buffer.from("valid")); await client.commitArchiveManifest(snapshot);
    await expect(repository.commit({ ...snapshot, byte_length: 123 })).rejects.toMatchObject({ status: 409 });
    await expect(client.commitArchiveManifest({ ...snapshot, byte_length: 123 })).rejects.toThrow("hash mismatch");
  });
  it("deduplicates appended full chunks, preserves rewrites and machine-scoped snapshots, and pages filters", async () => {
    const bytes = Buffer.concat([Buffer.alloc(ARCHIVE_CHUNK_BYTES, 66), Buffer.from("tail")]);
    await upload(bytes); const first = manifest(bytes); await client.commitArchiveManifest(first);
    const appended = Buffer.concat([bytes, Buffer.from("more")]);
    await upload(appended); const second = manifest(appended); await client.commitArchiveManifest(second);
    expect(first.chunks[0]).toEqual(second.chunks[0]);
    const otherMachine = manifest(bytes, { uploader_machine_id: "machine-b" }); await client.commitArchiveManifest(otherMachine);
    const rewritten = Buffer.from("rotated naming log"); await upload(rewritten);
    await client.commitArchiveManifest(manifest(rewritten, { source_type: "herdr_naming" }));
    const firstPage = await client.listArchiveManifests({ source_type: "sessions", uploader_machine_id: "machine-a", limit: 1 });
    expect(firstPage.items).toHaveLength(1); expect(firstPage.next_after).not.toBeNull();
    const nextPage = await client.listArchiveManifests({ source_type: "sessions", uploader_machine_id: "machine-a", limit: 1, after: firstPage.next_after! });
    expect(nextPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect((await client.listArchiveManifests({ source_type: "herdr_naming" })).items).toHaveLength(1);
  });
  it("finds literal matches across chunk and scan boundaries and pages dense results without loss", async () => {
    const bytes = Buffer.alloc(ARCHIVE_SEARCH_BYTES + 32, 120);
    bytes.write("needle", ARCHIVE_CHUNK_BYTES - 3); bytes.write("needle", ARCHIVE_SEARCH_BYTES - 3);
    const snapshot = manifest(bytes); await upload(bytes); await client.commitArchiveManifest(snapshot);
    const page = await client.searchArchive(snapshot.id, { q: "needle" });
    expect(page.matches.map((match) => match.offset)).toEqual([ARCHIVE_CHUNK_BYTES - 3, ARCHIVE_SEARCH_BYTES - 3]);
    expect(page.next_offset).toBe(ARCHIVE_SEARCH_BYTES);
    expect((await client.searchArchive(snapshot.id, { q: "needle", offset: page.next_offset! })).matches).toEqual([]);
    const denseBytes = Buffer.alloc(205, 97); const dense = manifest(denseBytes); await upload(denseBytes); await client.commitArchiveManifest(dense);
    const offsets: number[] = []; let offset: number | null = 0;
    do { const result = await client.searchArchive(dense.id, { q: "aa", offset }); offsets.push(...result.matches.map((match) => match.offset)); offset = result.next_offset; } while (offset !== null);
    expect(offsets).toEqual(Array.from({ length: 204 }, (_, index) => index));
    await expect(client.searchArchive(dense.id, { q: "a".repeat(257) })).rejects.toBeInstanceOf(OnclaveApiError);
  });
  it("rejects corrupted, oversized, and noncanonical chunk payloads without registering objects", async () => {
    const count = objects.size;
    const body = (data_base64: string, sha256 = "f".repeat(64)) => Buffer.from(JSON.stringify({ sha256, data_base64 }));
    await expect(service.upload(body(Buffer.from("wrong hash").toString("base64")))).rejects.toMatchObject({ status: 409 });
    await expect(service.upload(body("!!!="))).rejects.toMatchObject({ status: 400 });
    await expect(service.upload(body(Buffer.alloc(ARCHIVE_CHUNK_BYTES + 1).toString("base64")))).rejects.toMatchObject({ status: 400 });
    await expect(service.upload(Buffer.alloc(1500 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
    expect(objects.size).toBe(count);
  });
  it("supports empty snapshots and validates source and canonical identity", async () => {
    const empty = manifest(Buffer.alloc(0), { source_type: "codex_cache", session_id: null });
    expect((await client.commitArchiveManifest(empty)).byte_length).toBe(0);
    expect(await client.downloadArchive(empty.id)).toHaveLength(0);
    expect((await client.searchArchive(empty.id, { q: "anything" })).next_offset).toBeNull();
    expect(archiveManifestId({ ...empty, source: { ...empty.source, parent_source_path: undefined } })).toBe(archiveManifestId({ ...empty, source: { ...empty.source, parent_source_path: null } }));
    const bad = manifest(Buffer.alloc(0), { source_path: "../outside" });
    await expect(client.commitArchiveManifest(bad)).rejects.toMatchObject({ status: 400 });
    await expect(client.uploadArchiveChunk(Buffer.alloc(ARCHIVE_CHUNK_BYTES + 1))).rejects.toThrow("Archive chunk");
  });
});
