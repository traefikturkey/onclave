import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveUploadStatus } from "../src/lib/archive-uploader";

type Status = Pick<ArchiveUploadStatus, "running" | "owner" | "scanned" | "unchanged" | "committed" | "errors">;
type Worker = { child: ChildProcess; exited: Promise<void>; ready: boolean; status: Status; stderr: string; failure?: string };
const workers: Worker[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
  await Promise.all(workers.splice(0).map((worker) => worker.exited));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onclave-archive-worker-"));
  temporary.push(root);
  const runtimeDir = join(root, "runtime");
  async function profile(name = "default") {
    const profileDir = join(root, name);
    await mkdir(join(profileDir, "sessions"), { recursive: true });
    const source = join(profileDir, "sessions", "test.jsonl");
    await writeFile(source, "original\n");
    return { profileDir, source };
  }
  return { runtimeDir, profile };
}
async function start(profileDir: string, runtimeDir: string, intervalMs = 50): Promise<Worker> {
  const child = fork(fileURLToPath(new URL("./fixtures/archive-worker.ts", import.meta.url)), [profileDir, runtimeDir, String(intervalMs)], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const worker: Worker = { child, exited: new Promise((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); }), ready: false, status: { running: false, owner: false, scanned: 0, unchanged: 0, committed: 0, errors: 0 }, stderr: "" };
  workers.push(worker);
  child.stderr?.on("data", (bytes: Buffer) => { worker.stderr += bytes.toString(); });
  child.on("error", (error) => { worker.failure = error.message; });
  child.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("kind" in message) || !("status" in message)) return;
    if (message.kind === "ready") worker.ready = true;
    const s = message.status;
    if (typeof s !== "object" || s === null || !("running" in s) || !("owner" in s) || !("scanned" in s) || !("unchanged" in s) || !("committed" in s) || !("errors" in s)) return;
    if (typeof s.running !== "boolean" || typeof s.owner !== "boolean" || typeof s.scanned !== "number" || typeof s.unchanged !== "number" || typeof s.committed !== "number" || typeof s.errors !== "number") return;
    worker.status = { running: s.running, owner: s.owner, scanned: s.scanned, unchanged: s.unchanged, committed: s.committed, errors: s.errors };
  });
  await vi.waitFor(() => {
    expect(worker.failure, worker.stderr).toBeUndefined();
    expect(child.exitCode, worker.stderr).toBeNull();
    expect(worker.ready).toBe(true);
  }, { timeout: 10_000 });
  return worker;
}
async function owns(worker: Worker, committed = 1) {
  await vi.waitFor(() => {
    expect(worker.status.owner, worker.stderr).toBe(true);
    expect(worker.status.committed).toBeGreaterThanOrEqual(committed);
    expect(worker.status.errors).toBe(0);
  }, { timeout: 7_000 });
}

describe("archive worker ownership across processes", () => {
  it("retains one owner across scans and takes over a claim after abrupt owner exit", async () => {
    const f = await fixture();
    const p = await f.profile();
    const owner = await start(p.profileDir, f.runtimeDir);
    await owns(owner);
    const standby = await start(p.profileDir, f.runtimeDir);
    const previous = owner.status.unchanged;
    await vi.waitFor(() => expect(owner.status.unchanged).toBeGreaterThanOrEqual(previous + 3));
    expect(standby.status).toMatchObject({ owner: false, scanned: 0, committed: 0 });
    owner.child.kill("SIGKILL");
    await owner.exited;
    await writeFile(p.source, "after abrupt exit\n");
    await owns(standby);
  }, 20_000);

  it("forwards a standby sync to the owner and releases ownership on graceful stop", async () => {
    const f = await fixture();
    const p = await f.profile();
    const owner = await start(p.profileDir, f.runtimeDir, 60_000);
    await owns(owner);
    const standby = await start(p.profileDir, f.runtimeDir, 60_000);
    await writeFile(p.source, "append requested from standby\n");
    standby.child.send("sync");
    await owns(owner, 2); // Before the next periodic scan, through the shared request.
    expect(standby.status.scanned).toBe(0);
    owner.child.send("stop");
    await owner.exited;
    await writeFile(p.source, "after graceful stop\n");
    standby.child.send("sync");
    await owns(standby);
  }, 25_000);

  it("does not let a disconnected owner prevent another connected worker from uploading", async () => {
    const f = await fixture();
    const p = await f.profile();
    const owner = await start(p.profileDir, f.runtimeDir);
    await owns(owner);
    const standby = await start(p.profileDir, f.runtimeDir);
    owner.child.send("offline");
    await vi.waitFor(() => expect(owner.status.owner).toBe(false));
    await writeFile(p.source, "pending while old owner is offline\n");
    await owns(standby);
    expect(owner.child.exitCode).toBeNull();
  }, 20_000);

  it("allows separate profiles to have separate owners in the same runtime directory", async () => {
    const f = await fixture();
    const a = await f.profile("profile-a");
    const b = await f.profile("profile-b");
    const first = await start(a.profileDir, f.runtimeDir);
    const second = await start(b.profileDir, f.runtimeDir);
    await owns(first);
    await owns(second);
  }, 20_000);
});
