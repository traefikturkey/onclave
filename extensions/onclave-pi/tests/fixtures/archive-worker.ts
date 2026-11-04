import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ArchiveManifest } from "@onclave/client";
import { ArchiveUploader } from "../../src/lib/archive-uploader";

const [profileDir, runtimeDir, interval] = process.argv.slice(2);
if (!profileDir || !runtimeDir || !interval) throw new Error("archive worker fixture requires profile, runtime, and interval");
let connected = true;
const client = {
  async uploadArchiveChunk(bytes: Uint8Array) { return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }; },
  async commitArchiveManifest(manifest: ArchiveManifest) { return { ...manifest, created_at: "2026-01-01T00:00:00Z" }; },
};
const uploader = new ArchiveUploader({
  profileDir, runtimeDir, intervalMs: Number(interval), machineId: async () => "worker-fixture",
  client: () => connected ? client : undefined,
  onStatus: (status) => process.send?.({ kind: "status", status }),
});
process.on("message", async (message: unknown) => {
  if (message === "sync") uploader.sync();
  if (message === "offline") { connected = false; uploader.sync(); }
  if (message === "stop") {
    uploader.stop();
    while (uploader.status().running) await delay(10);
    process.disconnect();
  }
});
process.on("disconnect", () => uploader.stop());
uploader.start();
process.send?.({ kind: "ready", status: uploader.status() });
