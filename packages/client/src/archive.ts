import { createHash } from "node:crypto";

export const ARCHIVE_CHUNK_BYTES = 1024 * 1024;
export const ARCHIVE_MAX_CHUNKS = 8192;
export const ARCHIVE_SEARCH_BYTES = 4 * ARCHIVE_CHUNK_BYTES;
export const ARCHIVE_SOURCE_TYPES = ["sessions", "bedrock_usage", "codex_cache", "onclave_audit", "herdr_naming"] as const;
export type ArchiveSourceType = typeof ARCHIVE_SOURCE_TYPES[number];
/** Uploader is observation provenance, never evidence of historical origin. */
export type ArchiveSource = {
  source_type: ArchiveSourceType;
  uploader_machine_id: string;
  profile: string;
  source_path: string;
  origin_machine_id: string | null;
  session_id: string | null;
  project: string | null;
  parent_session_id: string | null;
  /** Preserve a native header's parent path when its session ID is unknown. */
  parent_source_path?: string | null;
};
export type ArchiveChunk = { sha256: string; size: number };
export type ArchiveManifestDraft = { source: ArchiveSource; chunks: ArchiveChunk[]; byte_length: number };
export type ArchiveManifest = ArchiveManifestDraft & { id: string };
export type ArchiveManifestRecord = ArchiveManifest & { created_at: string };
export type ArchiveListOptions = { source_type?: ArchiveSourceType; uploader_machine_id?: string; profile?: string; source_path?: string; session_id?: string; project?: string; after?: string; limit?: number };
export type ArchiveListResponse = { items: (Omit<ArchiveManifestRecord, "chunks"> & { chunk_count: number })[]; next_after: string | null };
export type ArchiveSearchResponse = { matches: { offset: number; preview: string }[]; next_offset: number | null; byte_length: number };

/** Version 1 canonical representation. No observation timestamps enter identity. */
export function archiveManifestCanonical(manifest: ArchiveManifestDraft): string {
  const s = manifest.source;
  return JSON.stringify({ source: { source_type: s.source_type, uploader_machine_id: s.uploader_machine_id, profile: s.profile, source_path: s.source_path, origin_machine_id: s.origin_machine_id, session_id: s.session_id, project: s.project, parent_session_id: s.parent_session_id, parent_source_path: s.parent_source_path ?? null }, chunks: manifest.chunks.map((chunk) => ({ sha256: chunk.sha256, size: chunk.size })), byte_length: manifest.byte_length });
}
export function archiveManifestId(manifest: ArchiveManifestDraft): string {
  return createHash("sha256").update(archiveManifestCanonical(manifest)).digest("hex");
}
