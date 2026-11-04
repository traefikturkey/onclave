import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ARCHIVE_CHUNK_BYTES, ARCHIVE_MAX_CHUNKS, ARCHIVE_SOURCE_TYPES, archiveManifestId, type ArchiveChunk, type ArchiveManifest, type ArchiveSource, type ArchiveSourceType, type OnclaveClient } from "@onclave/client";
import { onclaveRuntimeDir, persistentMachineId } from "./improvement-tools";

type ArchiveClient = Pick<OnclaveClient, "uploadArchiveChunk" | "commitArchiveManifest">;
export type ArchiveClientProvider = () => ArchiveClient | undefined | Promise<ArchiveClient | undefined>;
type Candidate = { path: string; sourcePath: string; type: ArchiveSourceType };
type Checkpoint = { version: 1; observed: string; manifest: ArchiveManifest };
export type ArchiveUploadStatus = { running: boolean; scanned: number; committed: number; unchanged: number; busy: number; errors: number; last_error: string | null };
export type ArchiveUploaderOptions = {
  profileDir: string;
  runtimeDir?: string;
  client: ArchiveClientProvider;
  machineId?: () => Promise<string>;
  intervalMs?: number;
  onStatus?: (status: ArchiveUploadStatus) => void;
};
const fixedSources: ReadonlyArray<readonly [string, ArchiveSourceType]> = [
  ["bedrock-usage.jsonl", "bedrock_usage"], ["codex-cache.jsonl", "codex_cache"],
  ["onclave/v2-audit.jsonl", "onclave_audit"], ["runtime/herdr-tab-naming.jsonl", "herdr_naming"],
];
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const isLegacy = (path: string): boolean => path.split(/[\\/]+/).some((part) => part.toLowerCase() === "legacy");

/** Only native session JSONL and the four explicitly approved producer files. */
export function archiveSourceType(sourcePath: string): ArchiveSourceType | undefined {
  const parts = sourcePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return undefined;
  if (parts[0] === "sessions" && parts.length >= 2 && parts.at(-1)?.endsWith(".jsonl")) return "sessions";
  return fixedSources.find(([path]) => path === sourcePath)?.[1];
}

async function safePath(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new Error("archive path is outside the active profile");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("archive does not follow symlinks");
  }
  if (await realpath(path) !== path) throw new Error("archive path changed during observation");
}

async function* candidates(root: string, signal?: AbortSignal): AsyncGenerator<Candidate> {
  async function* walk(dir: string): AsyncGenerator<Candidate> {
    signal?.throwIfAborted();
    try { await safePath(root, dir); } catch (error) { if (isMissing(error)) return; throw error; }
    const entries = await opendir(dir);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const sourcePath = relative(root, path).split(sep).join("/");
        const type = archiveSourceType(sourcePath);
        if (type) yield { path, sourcePath, type };
      }
    }
  }
  for (const [sourcePath, type] of fixedSources) {
    signal?.throwIfAborted();
    const path = join(root, ...sourcePath.split("/"));
    try { await safePath(root, path); if ((await lstat(path)).isFile()) yield { path, sourcePath, type }; }
    catch (error) { if (!isMissing(error) && !(error instanceof Error && error.message.includes("symlink"))) throw error; }
  }
  try { yield* walk(join(root, "sessions")); }
  catch (error) { if (!(error instanceof Error && error.message.includes("symlink"))) throw error; }
}

type Observation = Awaited<ReturnType<typeof observe>>;
async function observe(path: string) { return stat(path, { bigint: true }); }
function fingerprint(s: Observation): string { return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(":"); }
function unchanged(previous: Checkpoint | undefined, observed: Observation, machine: string, sourcePath: string): boolean {
  return observed.isFile() && previous?.observed === fingerprint(observed) && previous.manifest.source.uploader_machine_id === machine && previous.manifest.source.source_path === sourcePath;
}

function sourceAttribution(candidate: Candidate, profile: string, machine: string, first: Buffer): ArchiveSource {
  const source: ArchiveSource = { source_type: candidate.type, uploader_machine_id: machine, profile, source_path: candidate.sourcePath, origin_machine_id: null, session_id: null, project: null, parent_session_id: null, parent_source_path: null };
  if (candidate.type !== "sessions") return source;
  const newline = first.indexOf(10);
  if (newline < 0 || newline > 64 * 1024) return source;
  try {
    const header: unknown = JSON.parse(first.subarray(0, newline).toString("utf8"));
    if (typeof header !== "object" || header === null || !("type" in header) || header.type !== "session") return source;
    if ("id" in header && typeof header.id === "string") source.session_id = header.id;
    if ("cwd" in header && typeof header.cwd === "string") source.project = header.cwd;
    if ("origin_machine_id" in header && typeof header.origin_machine_id === "string") source.origin_machine_id = header.origin_machine_id;
    if ("parentSession" in header && typeof header.parentSession === "string") {
      source.parent_source_path = header.parentSession;
      source.parent_session_id = /(?:^|[_/\\])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i.exec(header.parentSession)?.[1] ?? null;
    }
  } catch { /* Unknown and partial records remain verbatim in chunks. */ }
  return source;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
async function readCheckpoint(path: string): Promise<Checkpoint | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!record(value) || value.version !== 1 || typeof value.observed !== "string" || !record(value.manifest)) return undefined;
    const m = value.manifest;
    if (typeof m.id !== "string" || !/^[0-9a-f]{64}$/.test(m.id) || !Array.isArray(m.chunks) || m.chunks.length > ARCHIVE_MAX_CHUNKS || !record(m.source) || typeof m.byte_length !== "number" || !Number.isSafeInteger(m.byte_length) || m.byte_length < 0) return undefined;
    const s = m.source;
    const sourceType = ARCHIVE_SOURCE_TYPES.find((type) => type === s.source_type);
    if (!sourceType || typeof s.uploader_machine_id !== "string" || typeof s.profile !== "string" || typeof s.source_path !== "string" || !nullableString(s.origin_machine_id) || !nullableString(s.session_id) || !nullableString(s.project) || !nullableString(s.parent_session_id) || (s.parent_source_path !== undefined && !nullableString(s.parent_source_path))) return undefined;
    const source: ArchiveSource = { source_type: sourceType, uploader_machine_id: s.uploader_machine_id, profile: s.profile, source_path: s.source_path, origin_machine_id: s.origin_machine_id, session_id: s.session_id, project: s.project, parent_session_id: s.parent_session_id, parent_source_path: s.parent_source_path ?? null };
    const chunks: ArchiveChunk[] = [];
    const rawChunks: unknown[] = m.chunks;
    for (const chunk of rawChunks) {
      if (!record(chunk) || typeof chunk.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(chunk.sha256) || typeof chunk.size !== "number" || !Number.isInteger(chunk.size) || chunk.size < 1 || chunk.size > ARCHIVE_CHUNK_BYTES) return undefined;
      chunks.push({ sha256: chunk.sha256, size: chunk.size });
    }
    if (chunks.some((chunk, index) => index < chunks.length - 1 && chunk.size !== ARCHIVE_CHUNK_BYTES) || chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== m.byte_length) return undefined;
    const manifest: ArchiveManifest = { id: m.id, source, chunks, byte_length: m.byte_length };
    if (archiveManifestId(manifest) !== manifest.id) return undefined;
    return { version: 1, observed: value.observed, manifest };
  } catch (error) { if (isMissing(error) || error instanceof SyntaxError) return undefined; throw error; }
}

type SourceLock = { check(): Promise<void>; release(): Promise<void> };
/** Per-source claims suppress duplicate work. Atomic manifests/checkpoints are
 * still the correctness boundary if stale-claim recovery races another scan. */
async function lockSource(path: string): Promise<SourceLock | undefined> {
  const token = `${process.pid}-${randomUUID()}`;
  const marker = join(path, token);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path);
      try { await (await open(marker, "wx", 0o600)).close(); }
      catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
      return {
        async check() { if (!(await lstat(marker).catch(() => undefined))?.isFile()) throw new Error("archive source claim changed; retry pending"); },
        async release() { if ((await lstat(marker).catch(() => undefined))?.isFile()) await rm(path, { recursive: true, force: true }); },
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const entries = await opendir(path).catch(() => undefined);
      if (!entries) return undefined;
      let owner: number | undefined;
      for await (const entry of entries) {
        const pid = /^(\d+)-/.exec(entry.name)?.[1];
        if (pid) owner = Number(pid);
      }
      if (owner === undefined) {
        const info = await stat(path).catch(() => undefined);
        if (!info || Date.now() - info.mtimeMs < 120_000) return undefined;
      } else {
        try { process.kill(owner, 0); return undefined; }
        catch (failure) { if (!(failure instanceof Error && "code" in failure && failure.code === "ESRCH")) return undefined; }
      }
      // Rename instead of recursive deletion at the shared path. If two stale
      // observers race, an uploader whose claim moved detects its missing
      // token before committing progress and cannot delete a newer claim.
      const retired = `${path}.${randomUUID()}.retired`;
      try { await rename(path, retired); }
      catch (failure) { if (isMissing(failure)) return undefined; throw failure; }
      await rm(retired, { recursive: true, force: true });
    }
  }
  return undefined;
}

export class ArchiveUploader {
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private requested = false;
  private readonly options: ArchiveUploaderOptions;
  private readonly current: ArchiveUploadStatus = { running: false, scanned: 0, committed: 0, unchanged: 0, busy: 0, errors: 0, last_error: null };
  constructor(options: ArchiveUploaderOptions) { this.options = options; }
  status(): ArchiveUploadStatus { return { ...this.current }; }
  start(): void {
    if (this.task) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.current.running = true;
    this.task = this.loop(signal).finally(() => { this.current.running = false; this.task = undefined; });
  }
  /** Schedule observation, never wait for a network upload on a Pi lifecycle hook. */
  sync(): ArchiveUploadStatus { this.requested = true; this.wake?.(); return this.status(); }
  stop(): void { this.controller?.abort(); this.wake?.(); }
  private report(error: unknown): void {
    this.current.errors++;
    this.current.last_error = error instanceof Error ? error.message : String(error);
    this.options.onStatus?.(this.status());
  }
  private async loop(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        this.requested = false;
        try { await this.scan(signal); this.options.onStatus?.(this.status()); }
        catch (error) { if (signal.aborted) break; this.report(error); }
        if (this.requested) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.options.intervalMs ?? 60_000);
          timer.unref?.();
          const self = this;
          function done() { clearTimeout(timer); signal.removeEventListener("abort", done); self.wake = undefined; resolve(); }
          this.wake = done;
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } catch (error) { if (!signal.aborted) this.report(error); }
  }
  /** Also used by focused offline fixture tests. No logging or session writes. */
  async scan(signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    if (isLegacy(this.options.profileDir)) throw new Error("legacy profiles are not archive sources");
    const root = await realpath(this.options.profileDir);
    if (isLegacy(root)) throw new Error("legacy profiles are not archive sources");
    const client = await this.options.client();
    if (!client) return;
    const runtimeDir = this.options.runtimeDir ?? onclaveRuntimeDir(this.options.profileDir);
    const machine = await (this.options.machineId ?? (() => persistentMachineId(runtimeDir)))();
    const checkpointDir = join(runtimeDir, "archive-checkpoints");
    await mkdir(checkpointDir, { recursive: true });
    const iterator = candidates(root, signal);
    const jobs: AsyncGenerator<void>[] = [];
    const errorsBefore = this.current.errors;
    try {
      let exhausted = false;
      while (!exhausted || jobs.length) {
        signal.throwIfAborted();
        while (!exhausted && jobs.length < 4) {
          const next = await iterator.next();
          exhausted = next.done === true;
          if (!next.done) jobs.push(this.upload(root, next.value, basename(root), machine, checkpointDir, client, signal));
        }
        // Round robin, one fixed-size chunk per source per sweep, then yield to Pi.
        for (let i = 0; i < jobs.length;) {
          try { const next = await jobs[i]!.next(); if (next.done) { jobs.splice(i, 1); continue; } }
          catch (error) { jobs.splice(i, 1); if (signal.aborted) throw error; this.report(error); continue; }
          i++;
        }
        await delay(10, undefined, { signal });
      }
    } finally {
      await iterator.return(undefined);
      await Promise.all(jobs.map((job) => job.return(undefined)));
    }
    if (this.current.errors === errorsBefore) this.current.last_error = null;
  }
  private async *upload(root: string, candidate: Candidate, profile: string, machine: string, checkpointDir: string, client: ArchiveClient, signal: AbortSignal): AsyncGenerator<void> {
    const key = hash(`${machine}\0${root}\0${candidate.sourcePath}`);
    const checkpointPath = join(checkpointDir, `${key}.json`);
    signal.throwIfAborted();
    await safePath(root, candidate.path);
    // Most sources are unchanged. Avoid creating a claim or opening the source
    // unless its committed checkpoint differs. Changed sources are checked again
    // under the claim so another uploader's progress is observed before uploading.
    const observed = await observe(candidate.path);
    if (unchanged(await readCheckpoint(checkpointPath), observed, machine, candidate.sourcePath)) {
      this.current.scanned++;
      this.current.unchanged++;
      return;
    }
    const claim = await lockSource(join(checkpointDir, `${key}.lock`));
    if (!claim) { this.current.busy++; return; }
    try {
      signal.throwIfAborted();
      await safePath(root, candidate.path);
      const file = await open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await safePath(root, candidate.path);
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || fingerprint(before) !== fingerprint(await observe(candidate.path))) throw new Error("archive source changed before reading");
        this.current.scanned++;
        const previous = await readCheckpoint(checkpointPath);
        if (unchanged(previous, before, machine, candidate.sourcePath)) { this.current.unchanged++; return; }
        const size = Number(before.size);
        if (size > ARCHIVE_MAX_CHUNKS * ARCHIVE_CHUNK_BYTES) throw new Error(`archive source exceeds ${ARCHIVE_MAX_CHUNKS} chunks: ${candidate.sourcePath}`);
        const chunks: ArchiveChunk[] = [];
        let source = sourceAttribution(candidate, profile, machine, Buffer.alloc(0));
        for (let offset = 0; offset < size; offset += ARCHIVE_CHUNK_BYTES) {
          signal.throwIfAborted();
          await claim.check();
          const bytes = Buffer.alloc(Math.min(ARCHIVE_CHUNK_BYTES, size - offset));
          let read = 0;
          while (read < bytes.length) {
            signal.throwIfAborted();
            const part = await file.read(bytes, read, bytes.length - read, offset + read);
            if (!part.bytesRead) throw new Error("archive source truncated during reading");
            read += part.bytesRead;
          }
          if (!offset) source = sourceAttribution(candidate, profile, machine, bytes);
          const sha256 = hash(bytes);
          chunks.push({ sha256, size: bytes.length });
          // Changed files are rehashed, never assumed append-only. Only known committed chunks are skipped.
          if (previous?.manifest.chunks[offset / ARCHIVE_CHUNK_BYTES]?.sha256 !== sha256) {
            await client.uploadArchiveChunk(bytes, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
          }
          yield;
        }
        signal.throwIfAborted();
        await safePath(root, candidate.path);
        if (fingerprint(before) !== fingerprint(await file.stat({ bigint: true })) || fingerprint(before) !== fingerprint(await observe(candidate.path))) throw new Error(`archive source changed during reading; retry pending: ${candidate.sourcePath}`);
        const draft = { source, chunks, byte_length: size };
        const manifest: ArchiveManifest = { ...draft, id: archiveManifestId(draft) };
        await claim.check();
        await client.commitArchiveManifest(manifest, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        await claim.check();
        // Never checkpoint uploaded chunks or observed metadata until the manifest commit succeeds.
        const checkpoint: Checkpoint = { version: 1, observed: fingerprint(before), manifest };
        const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
        try {
          const output = await open(temporary, "wx", 0o600);
          try { await output.writeFile(JSON.stringify(checkpoint)); await output.sync(); } finally { await output.close(); }
          await rename(temporary, checkpointPath);
        } finally { await rm(temporary, { force: true }); }
        this.current.committed++;
      } finally { await file.close(); }
    } finally { await claim.release(); }
  }
}
