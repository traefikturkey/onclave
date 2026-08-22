import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Pool } from "pg";
import type { Client as MinioClient } from "minio";
import {
  type ChunkModel,
  type ContentEntityEdge,
  type ContentMetadata,
  type EntityModel,
  type EntityType,
  type JobErrors,
  type JobTiming,
  type JsonObject,
  type LinkModel,
  type LlmUsage,
  type PipelineJob,
  type RelatedContent,
} from "./models";
import { DataTier, EntitySource, JobStatus } from "./models";
import { PIPELINE_STAGE_STATUSES, type PipelineStage, type PipelineStageStatus } from "./job-stages";

const CONTENT_COLUMNS = "id, content_type, title, description, mime_type, file_size, file_path, author, tags, tier, metadata, created_at, updated_at";
const ENTITY_COLUMNS = "id, entity_type, name, normalized_name, description, hierarchy, metadata, created_at, updated_at, source";

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[]; rowCount: number | null };

export type SqlClient = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
};

type TransactionClient = SqlClient & { release(): void };
type TransactionPool = SqlClient & { connect(): Promise<TransactionClient> };

export class S3Storage {
  readonly client: MinioClient;
  readonly bucket: string;

  constructor(client: MinioClient, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async upload(filePath: string, data: Readable, contentType: string): Promise<number> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      await this.client.putObject(this.bucket, filePath, body, body.length, { "Content-Type": contentType });
      return body.length;
    } catch (error: unknown) {
      throw new Error(`S3 upload failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async download(filePath: string): Promise<Buffer> {
    try {
      const response = await this.client.getObject(this.bucket, filePath);
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (error: unknown) {
      throw new Error(`S3 download failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async delete(filePath: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, filePath);
    } catch (error: unknown) {
      throw new Error(`S3 delete failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

export const MinIOStorage = S3Storage;

function newId(): string {
  return randomUUID().replaceAll("-", "");
}

function vectorLiteral(values: number[]): string {
  if (values.length !== 1024) throw new Error(`embedding must contain exactly 1024 values, got ${values.length}`);
  return `[${values.map((value) => Number(value).toPrecision(17)).join(",")}]`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function contentFromRow(row: Row): ContentMetadata {
  return {
    id: row.id as string | undefined,
    content_type: row.content_type as string,
    title: row.title as string | null | undefined,
    description: row.description as string | null | undefined,
    mime_type: row.mime_type as string,
    file_size: numberValue(row.file_size),
    file_path: row.file_path as string,
    author: row.author as string | null | undefined,
    tags: (row.tags as string[] | undefined) ?? [],
    tier: row.tier as string | null | undefined,
    metadata: jsonObject(row.metadata),
    created_at: row.created_at as Date | null | undefined,
    updated_at: row.updated_at as Date | null | undefined,
  };
}

function chunkFromRow(row: Row): ChunkModel {
  const rawEmbedding = row.embedding;
  const embedding = typeof rawEmbedding === "string"
    ? rawEmbedding.slice(1, -1).split(",").filter((value) => value !== "").map(Number)
    : rawEmbedding as number[] | null | undefined;
  return { id: row.id as string | undefined, content_id: row.content_id as string, text: row.text as string, chunk_index: numberValue(row.chunk_index), embedding, created_at: row.created_at as Date | null | undefined };
}

function linkFromRow(row: Row): LinkModel {
  return { id: row.id as string | undefined, source: row.source as string, target: row.target as string | null | undefined, link_text: row.link_text as string, link_type: row.link_type as string, created_at: row.created_at as Date | null | undefined };
}

function entityFromRow(row: Row): EntityModel {
  return { id: row.id as string | undefined, entity_type: row.entity_type as EntityType, name: row.name as string, normalized_name: row.normalized_name as string, description: row.description as string | null | undefined, hierarchy: row.hierarchy as string[] | null | undefined, metadata: jsonObject(row.metadata), created_at: row.created_at as Date | null | undefined, updated_at: row.updated_at as Date | null | undefined, source: row.source as EntitySource | undefined };
}

function edgeFromRow(row: Row): ContentEntityEdge {
  return { id: row.id as string | undefined, content_id: row.content_id as string, entity_id: row.entity_id as string, edge_type: row.edge_type as ContentEntityEdge["edge_type"], confidence: row.confidence === undefined || row.confidence === null ? row.confidence as null | undefined : numberValue(row.confidence), mention_count: row.mention_count === undefined || row.mention_count === null ? row.mention_count as null | undefined : numberValue(row.mention_count), source: row.source as EntitySource | undefined, created_at: row.created_at as Date | null | undefined };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(" ", "").replaceAll("-", "").replaceAll("_", "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min((previous[rightIndex - 1] ?? 0) + 1, above + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}

function parseVersion(version: unknown): [number, number, number] | undefined {
  if (typeof version !== "string" || version.trim() === "" || version.trim().toLowerCase() === "unknown") return undefined;
  const parts = version.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function hasVersionDrift(oldVersion: unknown, currentVersion: string): boolean {
  const oldParsed = parseVersion(oldVersion);
  const currentParsed = parseVersion(currentVersion);
  return oldParsed !== undefined && currentParsed !== undefined && (oldParsed[0] !== currentParsed[0] || oldParsed[1] !== currentParsed[1]);
}

export type ContentListOptions = { offset?: number; limit?: number; content_type?: string; tags?: string[]; exclude_tags?: string[]; order_by?: string };
export type VectorSearchFilters = { content_type?: string; tags?: string[]; exclude_tags?: string[]; valid_tiers?: string[]; minimum_score?: number };

export type YoutubeLogicalContent = {
  id: string;
  video_id: string;
  created_at: Date;
  updated_at: Date;
};

export type YoutubeTranscriptVersion = {
  id: string;
  logical_content_id: string;
  video_id: string;
  canonicalization_version: string;
  sha256: string;
  object_key: string;
  created_at: Date;
};

export type YoutubeTranscriptVersionInput = {
  video_id: string;
  canonicalization_version: string;
  sha256: string;
};

const YOUTUBE_VERSION_COLUMNS = "v.id, v.logical_content_id, l.youtube_video_id AS video_id, v.canonicalization_version, v.sha256, v.object_key, v.created_at";

function youtubeLogicalContentFromRow(row: Row): YoutubeLogicalContent {
  return {
    id: String(row.id),
    video_id: String(row.youtube_video_id),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function youtubeTranscriptVersionFromRow(row: Row): YoutubeTranscriptVersion {
  return {
    id: String(row.id),
    logical_content_id: String(row.logical_content_id),
    video_id: String(row.video_id),
    canonicalization_version: String(row.canonicalization_version),
    sha256: String(row.sha256),
    object_key: String(row.object_key),
    created_at: row.created_at as Date,
  };
}

export class PostgresRepository {
  private readonly database: SqlClient;

  constructor(database: SqlClient) {
    this.database = database;
  }

  async get_or_create_youtube_logical_content(videoId: string): Promise<YoutubeLogicalContent> {
    const result = await this.database.query(
      `INSERT INTO youtube_logical_content (id, youtube_video_id)
       VALUES ($1, $2)
       ON CONFLICT (youtube_video_id) DO UPDATE SET youtube_video_id = EXCLUDED.youtube_video_id
       RETURNING id, youtube_video_id, created_at, updated_at`,
      [newId(), videoId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`failed to create logical YouTube content: ${videoId}`);
    return youtubeLogicalContentFromRow(row);
  }

  async get_or_create_youtube_transcript_version(input: YoutubeTranscriptVersionInput): Promise<YoutubeTranscriptVersion> {
    const pool = this.database as Partial<TransactionPool>;
    if (pool.connect === undefined) throw new Error("database does not support transactions");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const logicalResult = await client.query(
        `INSERT INTO youtube_logical_content (id, youtube_video_id)
         VALUES ($1, $2)
         ON CONFLICT (youtube_video_id) DO UPDATE SET youtube_video_id = EXCLUDED.youtube_video_id
         RETURNING id, youtube_video_id, created_at, updated_at`,
        [newId(), input.video_id],
      );
      const logicalRow = logicalResult.rows[0];
      if (logicalRow === undefined) throw new Error(`failed to create logical YouTube content: ${input.video_id}`);
      const logical = youtubeLogicalContentFromRow(logicalRow);
      const versionColumns = "id, logical_content_id, canonicalization_version, sha256, object_key, created_at";
      const versionValues = [newId(), logical.id, input.canonicalization_version, input.sha256];
      const versionInsert = await client.query(
        `INSERT INTO youtube_transcript_version (id, logical_content_id, canonicalization_version, sha256)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (logical_content_id, canonicalization_version, sha256) DO NOTHING
         RETURNING ${versionColumns}`,
        versionValues,
      );
      const versionRow = versionInsert.rows[0] ?? (await client.query(
        `SELECT ${versionColumns}
         FROM youtube_transcript_version
         WHERE logical_content_id = $1 AND canonicalization_version = $2 AND sha256 = $3`,
        [logical.id, input.canonicalization_version, input.sha256],
      )).rows[0];
      if (versionRow === undefined) throw new Error(`failed to create YouTube transcript version: ${input.video_id}`);
      const version = youtubeTranscriptVersionFromRow({ ...versionRow, video_id: logical.video_id });
      const pointer = await client.query(
        `INSERT INTO youtube_transcript_current (logical_content_id, version_id)
         VALUES ($1, $2)
         ON CONFLICT (logical_content_id) DO UPDATE SET version_id = EXCLUDED.version_id
         RETURNING logical_content_id, version_id`,
        [logical.id, version.id],
      );
      if (pointer.rowCount !== 1) throw new Error(`failed to update current YouTube transcript version: ${input.video_id}`);
      await client.query("COMMIT");
      return version;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async insert_or_select_youtube_transcript_version(input: YoutubeTranscriptVersionInput): Promise<YoutubeTranscriptVersion> {
    return this.get_or_create_youtube_transcript_version(input);
  }

  async set_current_youtube_transcript_version(videoId: string, versionId: string): Promise<YoutubeTranscriptVersion | undefined> {
    const pool = this.database as Partial<TransactionPool>;
    if (pool.connect === undefined) throw new Error("database does not support transactions");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH target AS (
           SELECT l.id AS logical_content_id, v.id AS version_id
           FROM youtube_logical_content AS l
           JOIN youtube_transcript_version AS v ON v.logical_content_id = l.id
           WHERE l.youtube_video_id = $1 AND v.id = $2
         ), upserted AS (
           INSERT INTO youtube_transcript_current (logical_content_id, version_id)
           SELECT logical_content_id, version_id FROM target
           ON CONFLICT (logical_content_id) DO UPDATE SET version_id = EXCLUDED.version_id
           RETURNING logical_content_id, version_id
         )
         SELECT ${YOUTUBE_VERSION_COLUMNS}
         FROM upserted
         JOIN youtube_logical_content AS l ON l.id = upserted.logical_content_id
         JOIN youtube_transcript_version AS v
           ON v.logical_content_id = upserted.logical_content_id AND v.id = upserted.version_id`,
        [videoId, versionId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? undefined : youtubeTranscriptVersionFromRow(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get_current_youtube_transcript_version(videoId: string): Promise<YoutubeTranscriptVersion | undefined> {
    const result = await this.database.query(
      `SELECT ${YOUTUBE_VERSION_COLUMNS}
       FROM youtube_logical_content AS l
       JOIN youtube_transcript_current AS c ON c.logical_content_id = l.id
       JOIN youtube_transcript_version AS v
         ON v.logical_content_id = c.logical_content_id AND v.id = c.version_id
       WHERE l.youtube_video_id = $1`,
      [videoId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : youtubeTranscriptVersionFromRow(row);
  }

  async list_youtube_transcript_versions(videoId: string): Promise<YoutubeTranscriptVersion[]> {
    const result = await this.database.query(
      `SELECT ${YOUTUBE_VERSION_COLUMNS}
       FROM youtube_logical_content AS l
       JOIN youtube_transcript_version AS v ON v.logical_content_id = l.id
       WHERE l.youtube_video_id = $1
       ORDER BY v.created_at ASC, v.id ASC`,
      [videoId],
    );
    return result.rows.map(youtubeTranscriptVersionFromRow);
  }

  async get_youtube_transcript_history(videoId: string): Promise<YoutubeTranscriptVersion[]> {
    return this.list_youtube_transcript_versions(videoId);
  }

  async connect(): Promise<void> {
    await this.database.query("SELECT 1");
  }

  async close(): Promise<void> {
    const candidate = this.database as Pool;
    await candidate.end();
  }

  async create_content(metadata: ContentMetadata): Promise<ContentMetadata> {
    const now = new Date();
    const id = metadata.id ?? newId();
    const createdAt = metadata.created_at ?? now;
    const updatedAt = now;
    metadata.id = id;
    metadata.created_at = createdAt;
    metadata.updated_at = updatedAt;
    const values = [id, metadata.content_type, metadata.title ?? null, metadata.description ?? null, metadata.mime_type, metadata.file_size, metadata.file_path, metadata.author ?? null, metadata.tags ?? [], metadata.tier ?? null, metadata.metadata ?? {}, createdAt, updatedAt];
    const result = await this.database.query(`INSERT INTO content (${CONTENT_COLUMNS})\n            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\n            RETURNING ${CONTENT_COLUMNS}`, values);
    return contentFromRow(result.rows[0] ?? {});
  }

  async get_content(contentId: string): Promise<ContentMetadata | undefined> {
    const result = await this.database.query(`SELECT ${CONTENT_COLUMNS} FROM content WHERE id = $1`, [contentId]);
    return result.rows[0] === undefined ? undefined : contentFromRow(result.rows[0]);
  }

  async list_content(options: ContentListOptions = {}): Promise<[ContentMetadata[], number]> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    this.validatePagination(limit, offset, "content");
    const [where, params] = this.contentFilters(options.content_type, options.tags, options.exclude_tags);
    const ordering = this.contentOrder(options.order_by);
    const count = await this.database.query(`SELECT count(*) AS count FROM content${where}`, params);
    const rows = await this.database.query(`SELECT ${CONTENT_COLUMNS} FROM content${where} ORDER BY ${ordering} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
    return [rows.rows.map(contentFromRow), numberValue(count.rows[0]?.count) || 0];
  }

  private validatePagination(limit: number, offset: number, resource: string): void {
    if (limit < 1 || limit > 1000 || offset < 0) throw new Error(`invalid ${resource} pagination`);
  }

  private contentFilters(contentType?: string, tags?: string[], excludeTags?: string[]): [string, unknown[]] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: string | string[] | undefined): void => {
      if (value !== undefined && (!Array.isArray(value) || value.length > 0) && value !== "") {
        params.push(value);
        clauses.push(`${clause} $${params.length}`);
      }
    };
    add("content_type =", contentType);
    add("tags &&", tags);
    const effective = (excludeTags ?? ["test"]).filter((tag) => !tags?.includes(tag));
    add("NOT tags &&", effective);
    return [clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params];
  }

  private contentOrder(orderBy?: string): string {
    const orders: Record<string, string> = { "": "created_at DESC, id ASC", "created_at DESC": "created_at DESC, id ASC", "created_at ASC": "created_at ASC, id ASC", "updated_at DESC": "updated_at DESC, id ASC", "title ASC": "title ASC NULLS LAST, id ASC" };
    const order = orders[orderBy ?? ""];
    if (order === undefined) throw new Error("unsupported order_by");
    return order;
  }

  async get_content_stats(): Promise<{ total: number; by_status: Record<string, number>; by_content_type: Record<string, number> }> {
    const statusRows = await this.database.query("SELECT coalesce(processing_status, 'none') AS status, count(*) AS count FROM content GROUP BY 1");
    const typeRows = await this.database.query("SELECT content_type, count(*) AS count FROM content GROUP BY content_type");
    return { total: statusRows.rows.reduce((total, row) => total + numberValue(row.count), 0), by_status: Object.fromEntries(statusRows.rows.map((row) => [String(row.status), numberValue(row.count)])), by_content_type: Object.fromEntries(typeRows.rows.map((row) => [String(row.content_type), numberValue(row.count)])) };
  }

  async get_version_drift_report(currentVersion: string): Promise<{ current_version: string; stale_content: { version: string; count: number }[]; total_stale: number; unknown_version_count: number; total_content: number }> {
    const result = await this.database.query("SELECT pipeline_version, count(*) AS count FROM content WHERE processing_status = 'completed' GROUP BY pipeline_version");
    let unknown = 0;
    let total = 0;
    const stale = result.rows.flatMap((row) => {
      const count = numberValue(row.count);
      total += count;
      if (parseVersion(row.pipeline_version) === undefined) { unknown += count; return []; }
      return hasVersionDrift(row.pipeline_version, currentVersion) ? [{ version: String(row.pipeline_version), count }] : [];
    }).sort((left, right) => right.count - left.count || left.version.localeCompare(right.version));
    return { current_version: currentVersion, stale_content: stale, total_stale: stale.reduce((sum, item) => sum + item.count, 0), unknown_version_count: unknown, total_content: total };
  }

  async update_content(contentId: string, metadata: ContentMetadata): Promise<ContentMetadata> {
    const updatedAt = new Date();
    metadata.updated_at = updatedAt;
    const values = [metadata.content_type, metadata.title ?? null, metadata.description ?? null, metadata.mime_type, metadata.file_size, metadata.file_path, metadata.author ?? null, metadata.tags ?? [], metadata.tier ?? null, metadata.metadata ?? {}, updatedAt, contentId];
    const result = await this.database.query(`UPDATE content SET content_type=$1,title=$2,description=$3,mime_type=$4,\n            file_size=$5,file_path=$6,author=$7,tags=$8,tier=$9,metadata=$10,updated_at=$11\n            WHERE id=$12 RETURNING ${CONTENT_COLUMNS}`, values);
    if (result.rows[0] === undefined) throw new Error(`Failed to update content ${contentId}`);
    return contentFromRow(result.rows[0]);
  }

  async update_content_fields(contentId: string, fields: Partial<Pick<ContentMetadata, "title" | "tags" | "metadata" | "description" | "tier">>): Promise<ContentMetadata | undefined> {
    const selected = Object.entries(fields).filter(([key]) => ["title", "tags", "metadata", "description", "tier"].includes(key));
    if (selected.length === 0) return this.get_content(contentId);
    const values = selected.map(([, value]) => value);
    const assignments = selected.map(([key], index) => `${key} = $${index + 1}`);
    const result = await this.database.query(`UPDATE content SET ${assignments.join(", ")}, updated_at=now() WHERE id=$${values.length + 1} RETURNING ${CONTENT_COLUMNS}`, [...values, contentId]);
    return result.rows[0] === undefined ? undefined : contentFromRow(result.rows[0]);
  }

  async delete_content(contentId: string): Promise<void> { await this.database.query("DELETE FROM content WHERE id = $1", [contentId]); }

  async create_chunk(chunk: ChunkModel): Promise<ChunkModel> {
    const id = chunk.id ?? newId();
    const createdAt = chunk.created_at ?? new Date();
    chunk.id = id;
    chunk.created_at = createdAt;
    const result = await this.database.query("INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at)\n            VALUES ($1,$2,$3,$4,$5::vector,$6)\n            RETURNING id,content_id,text,chunk_index,embedding::text AS embedding,created_at", [id, chunk.content_id, chunk.text, chunk.chunk_index, chunk.embedding === null || chunk.embedding === undefined ? null : vectorLiteral(chunk.embedding), createdAt]);
    return chunkFromRow(result.rows[0] ?? {});
  }

  async get_chunks(contentId: string): Promise<ChunkModel[]> { return (await this.database.query("SELECT id,content_id,text,chunk_index,embedding::text AS embedding,created_at FROM chunk WHERE content_id=$1 ORDER BY chunk_index", [contentId])).rows.map(chunkFromRow); }
  async get_chunk_counts(contentIds: string[]): Promise<Record<string, number>> { if (contentIds.length === 0) return {}; return Object.fromEntries((await this.database.query("SELECT content_id,count(*) AS count FROM chunk WHERE content_id = ANY($1) GROUP BY content_id", [contentIds])).rows.map((row) => [String(row.content_id), numberValue(row.count)])); }
  async delete_chunks(contentId: string): Promise<void> { await this.database.query("DELETE FROM chunk WHERE content_id=$1", [contentId]); }

  async replace_content_chunks(contentId: string, chunks: ChunkModel[]): Promise<void> {
    if (chunks.length === 0) throw new Error("reindexed content requires at least one chunk");
    const pool = this.database as TransactionPool;
    if (typeof pool.connect !== "function") throw new Error("database does not support transactions");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chunk WHERE content_id=$1", [contentId]);
      const now = new Date();
      for (const chunk of chunks) {
        chunk.id ??= newId();
        chunk.created_at ??= now;
      }
      await client.query(
        "INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at)\n            SELECT item.id,$1,item.text,item.chunk_index,item.embedding::vector,item.created_at\n            FROM unnest($2::text[],$3::text[],$4::integer[],$5::text[],$6::timestamptz[])\n            AS item(id,text,chunk_index,embedding,created_at)",
        [
          contentId,
          chunks.map((chunk) => chunk.id as string),
          chunks.map((chunk) => chunk.text),
          chunks.map((chunk) => chunk.chunk_index),
          chunks.map((chunk) => vectorLiteral(chunk.embedding ?? [])),
          chunks.map((chunk) => chunk.created_at as Date),
        ],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async vector_search(embedding: number[], limit: number, filters: VectorSearchFilters = {}): Promise<Row[]> {
    if (limit < 1 || limit > 1000) throw new Error("invalid search limit");
    const unexpected = Object.keys(filters).find((key) => !["content_type", "tags", "exclude_tags", "valid_tiers", "minimum_score"].includes(key));
    if (unexpected !== undefined) throw new TypeError(`unexpected vector search filter: ${unexpected}`);
    const clauses = ["ch.embedding IS NOT NULL"];
    const params: unknown[] = [vectorLiteral(embedding)];
    const add = (clause: string, value: string | string[] | undefined): void => { if (value !== undefined && (!Array.isArray(value) || value.length > 0) && value !== "") { params.push(value); clauses.push(`${clause}$${params.length}`); } };
    add("c.content_type=", filters.content_type);
    add("c.tags && ", filters.tags);
    add("NOT c.tags && ", filters.exclude_tags);
    add("c.tier = ANY(", filters.valid_tiers);
    if (filters.valid_tiers !== undefined && filters.valid_tiers.length > 0) clauses[clauses.length - 1] += ")";
    const score = "1 - (ch.embedding <=> $1::vector)";
    if (filters.minimum_score !== undefined) { params.push(vectorLiteral(embedding), filters.minimum_score); clauses.push(`1 - (ch.embedding <=> $${params.length - 1}::vector) > $${params.length}`); }
    params.push(limit);
    return (await this.database.query(`SELECT ch.text,ch.content_id,c.title,c.content_type,${score} AS score\n            FROM chunk ch JOIN content c ON c.id=ch.content_id\n            WHERE ${clauses.join(" AND ")} ORDER BY score DESC,ch.id ASC LIMIT $${params.length}`, params)).rows;
  }

  async lexical_search(query: string, limit = 50): Promise<Row[]> {
    if (limit < 1 || limit > 1000) throw new Error("invalid search limit");
    return (await this.database.query("SELECT ch.text,ch.content_id,c.title,c.content_type,\n            ts_rank_cd(ch.search_document,websearch_to_tsquery('english',$1)) AS score\n            FROM chunk ch JOIN content c ON c.id=ch.content_id\n            WHERE ch.search_document @@ websearch_to_tsquery('english',$2)\n            ORDER BY score DESC,ch.id ASC LIMIT $3", [query, query, limit])).rows;
  }

  async fetch_content_metadata(contentIds: string[]): Promise<Record<string, { title: unknown; content_type: unknown }>> { if (contentIds.length === 0) return {}; return Object.fromEntries((await this.database.query("SELECT id,title,content_type FROM content WHERE id = ANY($1)", [contentIds])).rows.map((row) => [String(row.id), { title: row.title, content_type: row.content_type }])); }

  async filter_content_ids_by_entities(contentIds: string[], entityIds?: string[], entityTypes?: string[], topics?: string[]): Promise<Set<string>> {
    let matching = new Set(contentIds);
    for (const entityId of entityIds ?? []) { const rows = await this.database.query("SELECT content_id FROM content_entity WHERE entity_id=$1 AND content_id=ANY($2)", [entityId, [...matching]]); matching = new Set([...matching].filter((id) => rows.rows.some((row) => row.content_id === id))); }
    if (entityTypes !== undefined && entityTypes.length > 0 && matching.size > 0) { const rows = await this.database.query("SELECT DISTINCT ce.content_id FROM content_entity ce JOIN entity e ON e.id=ce.entity_id\n            WHERE ce.content_id=ANY($1) AND e.entity_type=ANY($2)", [[...matching], entityTypes]); matching = new Set([...matching].filter((id) => rows.rows.some((row) => row.content_id === id))); }
    for (const topic of topics ?? []) { const hierarchy = topic.split(">").map((part) => part.trim()); const rows = await this.database.query("SELECT DISTINCT ce.content_id FROM content_entity ce JOIN entity e ON e.id=ce.entity_id\n                WHERE ce.content_id=ANY($1) AND e.entity_type='topic' AND e.hierarchy @> $2", [[...matching], hierarchy]); matching = new Set([...matching].filter((id) => rows.rows.some((row) => row.content_id === id))); }
    return matching;
  }

  async list_tags_with_counts(): Promise<Row[]> { return (await this.database.query("SELECT tag AS name,count(*) AS count FROM content CROSS JOIN LATERAL unnest(tags) tag GROUP BY tag ORDER BY count DESC,tag ASC")).rows; }
  async get_tag_cooccurrence(minCount = 3, limit = 20): Promise<Record<string, string[]>> { const rows = (await this.database.query("SELECT tags FROM content WHERE processing_status='completed'")).rows; const counts = new Map<string, number>(); for (const row of rows) { const tags = [...new Set((row.tags as string[] | undefined) ?? [])].sort(); for (let index = 0; index < tags.length; index += 1) for (let other = index + 1; other < tags.length; other += 1) { const pair = `${tags[index]}\u0000${tags[other]}`; counts.set(pair, (counts.get(pair) ?? 0) + 1); } } const output: Record<string, [string, number][]> = {}; for (const [pair, count] of counts) if (count >= minCount) { const [left, right] = pair.split("\u0000") as [string, string]; (output[left] ??= []).push([right, count]); (output[right] ??= []).push([left, count]); } return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)).map(([tag, values]) => [tag, values.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit).map(([name]) => name)])); }
  async get_tier_distribution(): Promise<Record<string, number>> { return Object.fromEntries((await this.database.query("SELECT tier,count(*) AS count FROM content WHERE processing_status='completed' AND tier IS NOT NULL GROUP BY tier")).rows.map((row) => [String(row.tier).toUpperCase(), numberValue(row.count)])); }
  async get_tag_aliases(limit = 50): Promise<Record<string, string>> { return Object.fromEntries((await this.database.query("SELECT variant,canonical FROM tag_alias ORDER BY usage_count DESC,updated_at DESC,variant,canonical LIMIT $1", [limit])).rows.map((row) => [String(row.variant), String(row.canonical)])); }
  async record_tag_alias(variant: string, canonical: string): Promise<void> { await this.database.query("INSERT INTO tag_alias(id,variant,canonical,usage_count) VALUES($1,$2,$3,1) ON CONFLICT(variant,canonical) DO UPDATE SET usage_count=tag_alias.usage_count+1,updated_at=now()", [newId(), variant, canonical]); }

  async find_content_by_title(title: string): Promise<ContentMetadata | undefined> { return this.firstContent(`SELECT ${CONTENT_COLUMNS} FROM content WHERE title=$1 ORDER BY id LIMIT 1`, [title]); }
  async find_content_by_resource_key(resourceKey: string): Promise<ContentMetadata | undefined> { return this.firstContent(`SELECT ${CONTENT_COLUMNS} FROM content WHERE metadata->>'resource_key'=$1 ORDER BY id LIMIT 1`, [resourceKey]); }
  async find_content_by_video_id(videoId: string): Promise<ContentMetadata | undefined> { return this.firstContent(`SELECT ${CONTENT_COLUMNS} FROM content WHERE metadata->>'video_id'=$1 ORDER BY id LIMIT 1`, [videoId]); }
  async find_content_by_parent_id(parentContentId: string, contentType?: string): Promise<ContentMetadata[]> { const values: unknown[] = [parentContentId]; const typeClause = contentType === undefined || contentType === "" ? "" : (values.push(contentType), " AND content_type=$2"); return (await this.database.query(`SELECT ${CONTENT_COLUMNS} FROM content WHERE metadata->>'parent_content_id'=$1${typeClause} ORDER BY created_at DESC,id`, values)).rows.map(contentFromRow); }
  private async firstContent(text: string, values: unknown[]): Promise<ContentMetadata | undefined> { const result = await this.database.query(text, values); return result.rows[0] === undefined ? undefined : contentFromRow(result.rows[0]); }

  async create_link(link: LinkModel): Promise<LinkModel> { const id = link.id ?? newId(); const createdAt = link.created_at ?? new Date(); link.id = id; link.created_at = createdAt; const result = await this.database.query("INSERT INTO link(id,source,target,link_text,link_type,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [id, link.source, link.target ?? null, link.link_text, link.link_type, createdAt]); return linkFromRow(result.rows[0] ?? {}); }
  async delete_links_by_source(source: string): Promise<void> { await this.database.query("DELETE FROM link WHERE source=$1", [source]); }
  async get_links_by_source(source: string): Promise<LinkModel[]> { return (await this.database.query("SELECT * FROM link WHERE source=$1 ORDER BY id", [source])).rows.map(linkFromRow); }
  async get_links_by_target(target: string): Promise<LinkModel[]> { return (await this.database.query("SELECT * FROM link WHERE target=$1 ORDER BY id", [target])).rows.map(linkFromRow); }

  async get_graph_data(tags?: string[], contentType?: string, excludeTags?: string[], limit = 500): Promise<[ContentMetadata[], LinkModel[]]> { if (limit < 1 || limit > 1000) throw new Error("invalid graph limit"); const [where, params] = this.contentFilters(contentType, tags, excludeTags); const nodes = (await this.database.query(`SELECT ${CONTENT_COLUMNS} FROM content${where} ORDER BY created_at DESC,id LIMIT $${params.length + 1}`, [...params, limit])).rows.map(contentFromRow); const ids = nodes.flatMap((node) => node.id === undefined ? [] : [node.id]); return [nodes, await this.graphEdges(ids)]; }
  private async graphEdges(ids: string[]): Promise<LinkModel[]> { if (ids.length === 0) return []; return (await this.database.query("SELECT * FROM link WHERE source=ANY($1) OR target=ANY($2) ORDER BY id", [ids, ids])).rows.filter((row) => ids.includes(String(row.source)) && (row.target === null || row.target === undefined || ids.includes(String(row.target)))).map(linkFromRow); }
  async get_neighborhood(contentId: string, depth = 1): Promise<[ContentMetadata[], LinkModel[]]> { if (depth < 1 || depth > 3) throw new Error("depth must be between 1 and 3"); if (await this.get_content(contentId) === undefined) return [[], []]; const nodes = (await this.database.query("WITH RECURSIVE neighborhood(id,level) AS ( SELECT $1::text,0 UNION SELECT CASE WHEN l.source=n.id THEN l.target ELSE l.source END,n.level+1 FROM neighborhood n JOIN link l ON l.source=n.id OR l.target=n.id WHERE n.level < $2 AND CASE WHEN l.source=n.id THEN l.target ELSE l.source END IS NOT NULL) SELECT DISTINCT c.* FROM neighborhood n JOIN content c ON c.id=n.id", [contentId, depth])).rows.map(contentFromRow); const ids = nodes.flatMap((node) => node.id === undefined ? [] : [node.id]); if (ids.length === 0) return [nodes, []]; return [nodes, (await this.database.query("SELECT * FROM link WHERE source=ANY($1) AND target=ANY($2) ORDER BY id", [ids, ids])).rows.map(linkFromRow)]; }

  async get_related_content(contentId: string, limit = 10, window = "12m"): Promise<RelatedContent[]> { if (window !== "0" && !/^\d+[mwd]$/.test(window)) throw new Error("window must be '0' or match ^\\d+[mwd]$"); const values: unknown[] = [contentId]; let recency = ""; if (window !== "0") { const multiplier = window.endsWith("m") ? 30 : window.endsWith("w") ? 7 : 1; values.push(new Date(Date.now() - Number(window.slice(0, -1)) * multiplier * 86400000)); recency = ` AND other.created_at >= $${values.length}`; } values.push(limit); return (await this.database.query("SELECT other.id AS content_id,other.title,other.content_type, count(*) AS shared_entity_count,array_agg(DISTINCT e.name ORDER BY e.name) AS shared_entities FROM content_entity mine JOIN content_entity theirs ON theirs.entity_id=mine.entity_id AND theirs.content_id<>mine.content_id JOIN content other ON other.id=theirs.content_id JOIN entity e ON e.id=mine.entity_id WHERE mine.content_id=$1" + recency + ` GROUP BY other.id,other.title,other.content_type,other.created_at HAVING count(*) >= 2 ORDER BY shared_entity_count DESC,other.created_at DESC,other.id LIMIT $${values.length}`, values)).rows.map((row) => ({ content_id: String(row.content_id), title: String(row.title), content_type: String(row.content_type), shared_entity_count: numberValue(row.shared_entity_count), shared_entities: row.shared_entities as string[] })); }

  async create_entity(entity: EntityModel): Promise<EntityModel> { const id = entity.id ?? newId(); const now = new Date(); entity.id = id; entity.created_at ??= now; entity.updated_at = now; const result = await this.database.query("INSERT INTO entity(id,entity_type,name,normalized_name,description,hierarchy,metadata,created_at,updated_at,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [id, entity.entity_type, entity.name, entity.normalized_name, entity.description ?? null, entity.hierarchy ?? null, entity.metadata ?? {}, entity.created_at ?? now, now, entity.source ?? EntitySource.AI_EXTRACTED]); return entityFromRow(result.rows[0] ?? {}); }
  async get_entity(entityId: string): Promise<EntityModel | undefined> { const result = await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity WHERE id=$1`, [entityId]); return result.rows[0] === undefined ? undefined : entityFromRow(result.rows[0]); }
  async find_entity_by_normalized_name(normalizedName: string, entityType?: EntityType): Promise<EntityModel | undefined> { const result = entityType === undefined ? await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity WHERE normalized_name=$1 ORDER BY id LIMIT 1`, [normalizedName]) : await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity WHERE normalized_name=$1 AND entity_type=$2 ORDER BY id LIMIT 1`, [normalizedName, entityType]); return result.rows[0] === undefined ? undefined : entityFromRow(result.rows[0]); }
  async find_entity_by_alias(alias: string): Promise<EntityModel | undefined> { const result = await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity WHERE metadata->'aliases' ? $1 ORDER BY id LIMIT 1`, [alias]); return result.rows[0] === undefined ? undefined : entityFromRow(result.rows[0]); }
  async update_entity(entityId: string, updates: Partial<EntityModel>): Promise<EntityModel | undefined> { const current = await this.get_entity(entityId); if (current === undefined) return undefined; const entity = { ...current, ...updates }; const result = await this.database.query(`UPDATE entity SET entity_type=$1,name=$2,normalized_name=$3,description=$4,hierarchy=$5, metadata=$6,updated_at=now(),source=$7 WHERE id=$8 RETURNING ${ENTITY_COLUMNS}`, [entity.entity_type, entity.name, entity.normalized_name, entity.description ?? null, entity.hierarchy ?? null, entity.metadata ?? {}, entity.source ?? EntitySource.AI_EXTRACTED, entityId]); return result.rows[0] === undefined ? undefined : entityFromRow(result.rows[0]); }
  async delete_entity(entityId: string): Promise<void> { await this.database.query("DELETE FROM entity WHERE id=$1", [entityId]); }
  async list_entities(entityType?: EntityType, limit = 50, offset = 0): Promise<[EntityModel[], number]> { this.validatePagination(limit, offset, "entity"); const where = entityType === undefined ? "" : " WHERE entity_type=$1"; const params: unknown[] = entityType === undefined ? [] : [entityType]; const count = await this.database.query(`SELECT count(*) AS count FROM entity${where}`, params); const rows = await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity${where} ORDER BY name,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]); return [rows.rows.map(entityFromRow), numberValue(count.rows[0]?.count) || 0]; }
  async list_all_entities(): Promise<EntityModel[]> { return (await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity ORDER BY name,id`)).rows.map(entityFromRow); }
  async create_content_entity_edge(edge: ContentEntityEdge): Promise<ContentEntityEdge> { const id = edge.id ?? newId(); const createdAt = edge.created_at ?? new Date(); edge.id = id; edge.created_at = createdAt; const result = await this.database.query("INSERT INTO content_entity(id,content_id,entity_id,edge_type,confidence,mention_count,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [id, edge.content_id, edge.entity_id, edge.edge_type, edge.confidence ?? null, edge.mention_count ?? null, edge.source ?? EntitySource.AI_EXTRACTED, createdAt]); return edgeFromRow(result.rows[0] ?? {}); }
  async get_entities_for_content(contentId: string): Promise<[EntityModel, ContentEntityEdge][]> { return (await this.database.query("SELECT ce.*,to_jsonb(e.*)-'search_document' AS entity FROM content_entity ce JOIN entity e ON e.id=ce.entity_id WHERE ce.content_id=$1 ORDER BY ce.created_at,ce.id", [contentId])).rows.map((row) => [entityFromRow(row.entity as Row), edgeFromRow(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "entity")))]); }
  async get_content_for_entity(entityId: string, limit = 50, offset = 0): Promise<[ContentMetadata, ContentEntityEdge][]> { return (await this.database.query("SELECT ce.*,to_jsonb(c.*)-'search_document' AS content FROM content_entity ce JOIN content c ON c.id=ce.content_id WHERE ce.entity_id=$1 ORDER BY ce.created_at,ce.id LIMIT $2 OFFSET $3", [entityId, limit, offset])).rows.map((row) => [contentFromRow(row.content as Row), edgeFromRow(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "content")))]); }
  async delete_content_entity_edges(contentId: string): Promise<void> { await this.database.query("DELETE FROM content_entity WHERE content_id=$1", [contentId]); }
  async find_or_create_entity(name: string, entityType: EntityType, values: Omit<Partial<EntityModel>, "name" | "entity_type" | "normalized_name"> = {}): Promise<[EntityModel, boolean]> { const normalizedName = normalizeName(name); const existing = await this.find_entity_by_normalized_name(normalizedName, entityType); if (existing !== undefined) return [existing, false]; return [await this.create_entity({ ...values, entity_type: entityType, name, normalized_name: normalizedName }), true]; }
  async get_topic_hierarchy(): Promise<EntityModel[]> { return (await this.database.query(`SELECT ${ENTITY_COLUMNS} FROM entity WHERE entity_type='topic' ORDER BY hierarchy,name,id`)).rows.map(entityFromRow); }

  async update_content_processing_status(contentId: string, status: string, pipelineVersion?: string): Promise<void> { await this.database.query("UPDATE content SET processing_status=$1,pipeline_version=coalesce($2,pipeline_version),updated_at=now() WHERE id=$3", [status, pipelineVersion ?? null, contentId]); }
  async update_content_processing_result(contentId: string, result: JsonObject, pipelineVersion: string): Promise<void> { await this.database.query("UPDATE content SET metadata=jsonb_set(metadata,'{unified_result}',$1), processing_status='completed',processed_at=now(),pipeline_version=$2,updated_at=now() WHERE id=$3", [result, pipelineVersion, contentId]); }

  async complete_content_processing(contentId: string, result: JsonObject, pipelineVersion: string, chunks: ChunkModel[], relationships: ContentEntityEdge[]): Promise<void> {
    if (chunks.length === 0) throw new Error("completed content requires at least one chunk");
    const pool = this.database as TransactionPool;
    if (typeof pool.connect !== "function") throw new Error("database does not support transactions");
    const now = new Date();
    for (const edge of relationships) if (edge.content_id !== contentId) throw new Error("relationship content ID does not match completed content");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chunk WHERE content_id=$1", [contentId]);
      for (const chunk of chunks) { chunk.id ??= newId(); chunk.created_at ??= now; await client.query("INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at) VALUES ($1,$2,$3,$4,$5::vector,$6)", [chunk.id, contentId, chunk.text, chunk.chunk_index, vectorLiteral(chunk.embedding ?? []), chunk.created_at]); }
      await client.query("DELETE FROM content_entity WHERE content_id=$1", [contentId]);
      for (const edge of relationships) { edge.id ??= newId(); edge.created_at ??= now; await client.query("INSERT INTO content_entity (id,content_id,entity_id,edge_type,confidence,mention_count,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [edge.id, edge.content_id, edge.entity_id, edge.edge_type, edge.confidence ?? null, edge.mention_count ?? null, edge.source ?? EntitySource.AI_EXTRACTED, edge.created_at]); }
      const update = await client.query("UPDATE content SET metadata=jsonb_set(metadata,'{unified_result}',$1), processing_status='completed',processed_at=now(),pipeline_version=$2,updated_at=now() WHERE id=$3", [result, pipelineVersion, contentId]);
      if (update.rowCount !== 1) throw new Error(`content not found while completing processing: ${contentId}`);
      await client.query("COMMIT");
    } catch (error: unknown) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async find_potential_duplicates(maxDistance = 1): Promise<EntityModel[][]> { const entities = await this.list_all_entities(); const groups: EntityModel[][] = []; const used = new Set<number>(); for (let index = 0; index < entities.length; index += 1) { if (used.has(index)) continue; const entity = entities[index]; if (entity === undefined) continue; const group = [entity]; for (let otherIndex = index + 1; otherIndex < entities.length; otherIndex += 1) { const other = entities[otherIndex]; if (other !== undefined && !used.has(otherIndex) && editDistance(entity.normalized_name, other.normalized_name) <= maxDistance) { group.push(other); used.add(otherIndex); } } if (group.length > 1) { groups.push(group); used.add(index); } } return groups; }
  async get_content_processing_status(contentId: string): Promise<string | undefined> { const result = await this.database.query("SELECT processing_status FROM content WHERE id=$1", [contentId]); return result.rows[0]?.processing_status as string | undefined; }
  async get_pipeline_result(contentId: string): Promise<JsonObject | undefined> { const result = await this.database.query("SELECT processing_status, metadata->'unified_result' AS unified_result FROM content WHERE id=$1", [contentId]); const row = result.rows[0]; return row?.processing_status === "completed" && row.unified_result !== null && typeof row.unified_result === "object" && !Array.isArray(row.unified_result) ? row.unified_result as JsonObject : undefined; }

  async create_pipeline_job(job: PipelineJob): Promise<Row> { const result = await this.database.query("INSERT INTO pipeline_job(id,resource_key,content_id,status,pipeline_version,data_tier, error_code,error_message,error_stage,metadata,created_at,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *", [job.id, job.resource_key, job.content_id, job.status ?? JobStatus.PENDING, job.pipeline_version ?? "", job.data_tier ?? DataTier.COMPACT, job.error_code ?? null, job.error_message ?? null, job.error_stage ?? null, job.metadata ?? {}, job.created_at ?? null, job.started_at ?? null, job.finished_at ?? null]); return result.rows[0] ?? job as Row; }
  async get_pipeline_job(jobId: string): Promise<Row | undefined> { return (await this.database.query("SELECT * FROM pipeline_job WHERE id=$1", [jobId])).rows[0]; }
  async find_active_pipeline_job(resourceKey: string): Promise<Row | undefined> { return (await this.database.query("SELECT * FROM pipeline_job WHERE resource_key=$1 AND status=ANY($2) ORDER BY created_at DESC,id LIMIT 1", [resourceKey, [JobStatus.PENDING, JobStatus.PROCESSING]])).rows[0]; }
  async add_pipeline_job_subscriber(jobId: string, subscriberId: string): Promise<Row | undefined> {
    return (await this.database.query(`UPDATE pipeline_job
      SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb), '{notify_agent_ids}',
        (SELECT jsonb_agg(agent_id ORDER BY agent_id) FROM (
          SELECT DISTINCT value AS agent_id
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata->'notify_agent_ids')='array' THEN metadata->'notify_agent_ids' ELSE '[]'::jsonb END)
          UNION SELECT metadata->>'notify_agent_id'
          WHERE metadata->>'notify_agent_id' IS NOT NULL
          UNION SELECT $2
        ) subscribers))
      WHERE id=$1 AND status=ANY($3) RETURNING *`, [jobId, subscriberId, [JobStatus.PENDING, JobStatus.PROCESSING]])).rows[0];
  }
  async update_pipeline_job(jobId: string, status: JobStatus, timing: JobTiming, errors: JobErrors): Promise<Row | undefined> { return (await this.database.query("UPDATE pipeline_job SET status=$1,started_at=coalesce($2,started_at), finished_at=coalesce($3,finished_at),error_code=coalesce($4,error_code), error_message=coalesce($5,error_message),error_stage=coalesce($6,error_stage) WHERE id=$7 RETURNING *", [status, timing[0] ?? null, timing[1] ?? null, errors[0] ?? null, errors[1] ?? null, errors[2] ?? null, jobId])).rows[0]; }
  async transition_pipeline_job_terminal(jobId: string, status: JobStatus, timing: JobTiming, errors: JobErrors, expectedStatuses: readonly JobStatus[]): Promise<Row | undefined> { return (await this.database.query("UPDATE pipeline_job SET status=$1,started_at=coalesce($2,started_at), finished_at=coalesce($3,finished_at),error_code=coalesce($4,error_code), error_message=coalesce($5,error_message),error_stage=coalesce($6,error_stage) WHERE id=$7 AND status=ANY($8) RETURNING *", [status, timing[0] ?? null, timing[1] ?? null, errors[0] ?? null, errors[1] ?? null, errors[2] ?? null, jobId, expectedStatuses])).rows[0]; }
  async transition_pipeline_job_stage(jobId: string, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined], expectedStatuses: readonly PipelineStageStatus[]): Promise<Row | undefined> {
    if (!PIPELINE_STAGE_STATUSES.includes(status)) throw new Error(`invalid pipeline stage status: ${status}`);
    const state: Record<string, unknown> = { status };
    if (timing[0] !== undefined) state.started_at = timing[0]?.toISOString() ?? null;
    if (timing[1] !== undefined) state.finished_at = timing[1]?.toISOString() ?? null;
    if (errors[0] !== undefined) state.error_code = errors[0] ?? null;
    if (errors[1] !== undefined) state.error_message = errors[1] ?? null;
    return (await this.database.query(`UPDATE pipeline_job
      SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb), ARRAY['stages',$2], coalesce(metadata->'stages'->$2, '{}'::jsonb) || $3::jsonb, true)
      WHERE id=$1 AND (status=ANY($4) OR (status='failed' AND $3::jsonb->>'status'=ANY(ARRAY['failed','skipped']))) AND coalesce(metadata->'stages'->>$2,'pending')=ANY($5)
      RETURNING *`, [jobId, stage, JSON.stringify(state), [JobStatus.PENDING, JobStatus.PROCESSING], expectedStatuses])).rows[0];
  }
  async list_pipeline_jobs(contentId: string | undefined, status: JobStatus | undefined, limit: number, offset: number): Promise<[Row[], number]> { const clauses: string[] = []; const params: unknown[] = []; if (contentId !== undefined) { params.push(contentId); clauses.push(`content_id=$${params.length}`); } if (status !== undefined) { params.push(status); clauses.push(`status=$${params.length}`); } const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`; const count = await this.database.query(`SELECT count(*) AS count FROM pipeline_job${where}`, params); const rows = await this.database.query(`SELECT * FROM pipeline_job${where} ORDER BY created_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]); return [rows.rows, numberValue(count.rows[0]?.count) || 0]; }
  async get_pipeline_job_stats(): Promise<{ total_jobs: number; completed_jobs: number; failed_jobs: number; cancelled_jobs: number; average_completion_seconds: number | null }> { const result = await this.database.query("SELECT count(*) AS total_jobs,count(*) FILTER (WHERE status='completed') AS completed_jobs,count(*) FILTER (WHERE status='failed') AS failed_jobs,count(*) FILTER (WHERE status='cancelled') AS cancelled_jobs,avg(extract(epoch FROM (finished_at-started_at))) FILTER (WHERE status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL) AS average_completion_seconds FROM pipeline_job"); const row = result.rows[0] ?? {}; const average = row.average_completion_seconds; return { total_jobs: numberValue(row.total_jobs), completed_jobs: numberValue(row.completed_jobs), failed_jobs: numberValue(row.failed_jobs), cancelled_jobs: numberValue(row.cancelled_jobs), average_completion_seconds: average === null || average === undefined ? null : numberValue(average) }; }
  async purge_expired_jobs(): Promise<{ compact: number; full: number }> { const compact = await this.database.query("DELETE FROM pipeline_job WHERE data_tier='compact' AND finished_at < now()-interval '180 days'"); const full = await this.database.query("DELETE FROM pipeline_job WHERE data_tier='full' AND finished_at < now()-interval '60 days'"); return { compact: compact.rowCount ?? 0, full: full.rowCount ?? 0 }; }

  async record_llm_usage(usage: LlmUsage): Promise<void> { await this.database.query("INSERT INTO llm_usage(id,provider,model,input_tokens,output_tokens,input_price_per_million, output_price_per_million,estimated_cost,context,duration_ms,pricing_snapshot_refreshed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [newId(), usage.provider, usage.model, usage.input_tokens, usage.output_tokens, usage.input_price_per_million, usage.output_price_per_million, usage.estimated_cost, usage.context, usage.duration_ms, usage.pricing_snapshot_refreshed_at ?? null]); }
  async get_pricing_snapshot(snapshotId: string): Promise<Row | undefined> { return (await this.database.query("SELECT id,pricing,refreshed_at,source FROM llm_pricing_snapshot WHERE id=$1", [snapshotId])).rows[0]; }
  async upsert_pricing_snapshot(snapshotId: string, pricing: JsonObject, refreshedAt: Date, source: string): Promise<void> { await this.database.query("INSERT INTO llm_pricing_snapshot(id,pricing,refreshed_at,source) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET pricing=excluded.pricing,refreshed_at=excluded.refreshed_at,source=excluded.source", [snapshotId, pricing, refreshedAt, source]); }
  private usageFilters(start?: Date, end?: Date, provider?: string, model?: string): [string, unknown[]] { const clauses: string[] = []; const params: unknown[] = []; for (const [clause, item] of [["created_at >=", start], ["created_at <=", end], ["provider =", provider], ["model =", model]] as const) if (item !== undefined && item !== null) { params.push(item); clauses.push(`${clause} $${params.length}`); } return [clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params]; }
  async usage_totals(start?: Date, end?: Date, provider?: string, model?: string): Promise<Row> { const [where, params] = this.usageFilters(start, end, provider, model); return (await this.database.query("SELECT count(*) AS total_calls,coalesce(sum(input_tokens),0) AS total_input_tokens,coalesce(sum(output_tokens),0) AS total_output_tokens,coalesce(sum(estimated_cost),0) AS estimated_total_cost FROM llm_usage" + where, params)).rows[0] ?? {}; }
  async usage_breakdown(start?: Date, end?: Date, provider?: string, model?: string): Promise<Row[]> { const [where, params] = this.usageFilters(start, end, provider, model); return (await this.database.query("SELECT provider,model,count(*) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(estimated_cost) AS estimated_cost FROM llm_usage" + where + " GROUP BY provider,model ORDER BY estimated_cost DESC,provider,model", params)).rows; }
}

export const SurrealDBRepository = PostgresRepository;
