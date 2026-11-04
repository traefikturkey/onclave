import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ARCHIVE_CHUNK_BYTES, ARCHIVE_MAX_CHUNKS, ARCHIVE_SEARCH_BYTES, ARCHIVE_SOURCE_TYPES, archiveManifestCanonical, archiveManifestId, type ArchiveChunk, type ArchiveManifest, type ArchiveManifestRecord, type ArchiveSource, type ArchiveListResponse } from "../../../../packages/client/src/archive";
import type { SqlClient } from "./storage";
import type { VaultObjectStorage } from "./routes";
import { HttpError } from "./errors";
import { jsonResponse, rawResponse, type VaultHandlers } from "./http";

const HASH = /^[0-9a-f]{64}$/;
const MANIFEST_BYTES = 1024 * 1024;
function invalid(message: string): never { throw new HttpError(400, message); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("Expected object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) return invalid(`Invalid ${name}`);
  return value;
}
function nullable(value: unknown, name: string): string | null { return value === null ? null : text(value, name); }
function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid(`Invalid ${name}`);
  return value;
}
function hash(value: unknown): string { const id = text(value, "sha256", 64); if (!HASH.test(id)) return invalid("Invalid sha256"); return id; }
function parse(body: Buffer, max: number): Record<string, unknown> {
  if (body.length > max) throw new HttpError(413, "Archive request too large");
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); } catch { return invalid("Invalid JSON"); }
  return object(value);
}
function manifestInput(body: Buffer): ArchiveManifest {
  const value = parse(body, MANIFEST_BYTES);
  const s = object(value.source);
  if (!ARCHIVE_SOURCE_TYPES.some((type) => type === s.source_type)) return invalid("Invalid source_type");
  const source: ArchiveSource = {
    source_type: s.source_type as ArchiveSource["source_type"],
    uploader_machine_id: text(s.uploader_machine_id, "uploader_machine_id", 256),
    profile: text(s.profile, "profile", 256), source_path: text(s.source_path, "source_path"),
    origin_machine_id: nullable(s.origin_machine_id, "origin_machine_id"),
    session_id: nullable(s.session_id, "session_id"), project: nullable(s.project, "project"),
    parent_session_id: nullable(s.parent_session_id, "parent_session_id"),
    parent_source_path: nullable(s.parent_source_path ?? null, "parent_source_path"),
  };
  if (/^(?:[a-zA-Z]:|[/\\])/.test(source.source_path) || source.source_path.split(/[/\\]/).includes("..")) return invalid("source_path must be source-relative");
  if (!Array.isArray(value.chunks) || value.chunks.length > ARCHIVE_MAX_CHUNKS) return invalid("Invalid chunks");
  const chunks: ArchiveChunk[] = value.chunks.map((entry, index) => {
    const chunk = object(entry);
    const size = integer(chunk.size, "chunk size", ARCHIVE_CHUNK_BYTES);
    if (size === 0 || (index < (value.chunks as unknown[]).length - 1 && size !== ARCHIVE_CHUNK_BYTES)) return invalid("Only final chunk may be short");
    return { sha256: hash(chunk.sha256), size };
  });
  const byte_length = integer(value.byte_length, "byte_length", ARCHIVE_CHUNK_BYTES * ARCHIVE_MAX_CHUNKS);
  if (chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== byte_length) return invalid("byte_length does not match chunks");
  const manifest: ArchiveManifest = { id: hash(value.id), source, chunks, byte_length };
  if (archiveManifestId(manifest) !== manifest.id) throw new HttpError(409, "Manifest hash mismatch");
  return manifest;
}

type TransactionPool = SqlClient & { connect(): Promise<SqlClient & { release(): void }> };
export class ArchiveRepository {
  constructor(private readonly database: TransactionPool) {}
  async registerChunk(sha256: string, size: number): Promise<void> {
    await this.database.query("INSERT INTO archive_chunk (sha256,size) VALUES ($1,$2) ON CONFLICT (sha256) DO NOTHING", [sha256, size]);
    const result = await this.database.query("SELECT size FROM archive_chunk WHERE sha256=$1", [sha256]);
    if (Number(result.rows[0]?.size) !== size) throw new HttpError(409, "Chunk size conflict");
  }
  async commit(manifest: ArchiveManifest): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const canonical = archiveManifestCanonical(manifest);
      const inserted = await client.query("INSERT INTO archive_manifest (id,source,byte_length,canonical) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id", [manifest.id, JSON.stringify(manifest.source), manifest.byte_length, canonical]);
      const stored = await client.query("SELECT canonical FROM archive_manifest WHERE id=$1", [manifest.id]);
      if (stored.rows[0]?.canonical !== canonical) throw new HttpError(409, "Manifest ID conflict");
      if (inserted.rows.length > 0 && manifest.chunks.length > 0) {
        const chunks = await client.query("SELECT sha256,size FROM archive_chunk WHERE sha256=ANY($1::text[])", [manifest.chunks.map((chunk) => chunk.sha256)]);
        const sizes = new Map(chunks.rows.map((row) => [String(row.sha256), Number(row.size)]));
        if (manifest.chunks.some((chunk) => sizes.get(chunk.sha256) !== chunk.size)) throw new HttpError(409, "Upload all referenced chunks before committing");
        await client.query(`INSERT INTO archive_manifest_chunk (manifest_id,chunk_index,sha256,size)
          SELECT $1, (ordinality-1)::integer, sha256, size FROM unnest($2::text[],$3::integer[]) WITH ORDINALITY AS c(sha256,size,ordinality)`, [manifest.id, manifest.chunks.map((chunk) => chunk.sha256), manifest.chunks.map((chunk) => chunk.size)]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async get(id: string): Promise<ArchiveManifestRecord> {
    const result = await this.database.query("SELECT canonical,created_at FROM archive_manifest WHERE id=$1", [id]);
    const row = result.rows[0];
    if (row === undefined) throw new HttpError(404, "Archive manifest not found");
    // Canonical JSON was validated before insertion. Raw source records are never parsed.
    const draft = JSON.parse(String(row.canonical)) as Omit<ArchiveManifest, "id">;
    return { id, source: draft.source, chunks: draft.chunks, byte_length: draft.byte_length, created_at: new Date(String(row.created_at)).toISOString() };
  }
  async list(query: Record<string, string>): Promise<ArchiveListResponse> {
    const limit = integer(Number(query.limit ?? 50), "limit", 100);
    if (limit === 0) return invalid("limit must be positive");
    const values: unknown[] = [query.after === undefined ? "" : hash(query.after)];
    const clauses = ["id > $1"];
    for (const key of ["source_type", "uploader_machine_id", "profile", "source_path", "session_id", "project"]) {
      if (query[key] === undefined) continue;
      values.push(text(query[key], key));
      clauses.push(`source->>'${key}'=$${values.length}`);
    }
    values.push(limit + 1);
    const result = await this.database.query(`SELECT id,source,byte_length,created_at,(SELECT count(*) FROM archive_manifest_chunk c WHERE c.manifest_id=m.id) AS chunk_count FROM archive_manifest m WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, limit);
    return { items: rows.map((row) => ({ id: String(row.id), source: row.source as ArchiveSource, byte_length: Number(row.byte_length), chunk_count: Number(row.chunk_count), created_at: new Date(String(row.created_at)).toISOString() })), next_after: result.rows.length > limit ? String(rows.at(-1)?.id) : null };
  }
}

export class ArchiveService {
  constructor(readonly repository: ArchiveRepository, private readonly storage: Pick<VaultObjectStorage, "upload" | "download">) {}
  async upload(body: Buffer): Promise<ArchiveChunk> {
    const value = parse(body, 1500 * 1024);
    const sha256 = hash(value.sha256);
    const encoded = text(value.data_base64, "data_base64", Math.ceil(ARCHIVE_CHUNK_BYTES / 3) * 4);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > ARCHIVE_CHUNK_BYTES || bytes.toString("base64") !== encoded) return invalid("Invalid chunk base64");
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new HttpError(409, "Chunk hash mismatch");
    // Concurrent uploads at this key have identical verified bytes. A failed PUT
    // never registers a chunk; retrying a successful PUT is safe across machines.
    await this.storage.upload(`archive/chunks/${sha256}`, Readable.from([bytes]), "application/octet-stream");
    await this.repository.registerChunk(sha256, bytes.length);
    return { sha256, size: bytes.length };
  }
  async read(manifest: ArchiveManifest, offset: number, limit: number): Promise<Buffer> {
    const end = Math.min(manifest.byte_length, offset + limit);
    const parts: Buffer[] = [];
    for (let index = Math.floor(offset / ARCHIVE_CHUNK_BYTES); index * ARCHIVE_CHUNK_BYTES < end; index++) {
      const chunk = manifest.chunks[index];
      if (chunk === undefined) throw new Error("Archive chunk reference missing");
      const bytes = await this.storage.download(`archive/chunks/${chunk.sha256}`);
      if (bytes.length !== chunk.size || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw new Error("Archive object integrity check failed");
      parts.push(bytes.subarray(Math.max(0, offset - index * ARCHIVE_CHUNK_BYTES), Math.min(bytes.length, end - index * ARCHIVE_CHUNK_BYTES)));
    }
    return Buffer.concat(parts);
  }
}

export function createArchiveHandlers(service: ArchiveService): VaultHandlers {
  const get = (id: string | undefined) => service.repository.get(hash(id));
  return {
    archiveChunkUpload: async ({ body }) => jsonResponse(await service.upload(body), 201),
    archiveManifestCommit: async ({ body }) => {
      const manifest = manifestInput(body);
      await service.repository.commit(manifest);
      return jsonResponse(await service.repository.get(manifest.id), 201);
    },
    archiveManifestList: async ({ query }) => jsonResponse(await service.repository.list(query)),
    archiveManifestGet: async ({ params }) => jsonResponse(await get(params.manifest_id)),
    archiveDownload: async ({ params, query }) => {
      const manifest = await get(params.manifest_id);
      const offset = integer(Number(query.offset ?? 0), "offset", manifest.byte_length);
      const limit = integer(Number(query.limit ?? ARCHIVE_CHUNK_BYTES), "limit", ARCHIVE_CHUNK_BYTES);
      if (limit === 0) return invalid("limit must be positive");
      const bytes = await service.read(manifest, offset, limit);
      return rawResponse(bytes, "application/octet-stream", 200, { "x-archive-byte-length": String(manifest.byte_length), "x-archive-next-offset": String(offset + bytes.length), "x-archive-manifest-id": manifest.id });
    },
    archiveSearch: async ({ params, query }) => {
      const manifest = await get(params.manifest_id);
      const q = Buffer.from(text(query.q, "q", 256), "utf8");
      if (q.length > 256) return invalid("q must be at most 256 UTF-8 bytes");
      const offset = integer(Number(query.offset ?? 0), "offset", manifest.byte_length);
      const scanEnd = Math.min(manifest.byte_length, offset + ARCHIVE_SEARCH_BYTES);
      // Extra lookahead finds needles starting just before the next page boundary.
      const bytes = await service.read(manifest, offset, scanEnd - offset + q.length - 1);
      const matches: { offset: number; preview: string }[] = [];
      let position = 0;
      let next = scanEnd;
      while ((position = bytes.indexOf(q, position)) !== -1 && offset + position < scanEnd) {
        matches.push({ offset: offset + position, preview: bytes.subarray(Math.max(0, position - 80), Math.min(bytes.length, position + q.length + 80)).toString("utf8") });
        position++;
        if (matches.length === 100) { next = offset + position; break; }
      }
      return jsonResponse({ matches, next_offset: next < manifest.byte_length ? next : null, byte_length: manifest.byte_length });
    },
  };
}
