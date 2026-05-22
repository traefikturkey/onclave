import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAuditEvent } from "../../src/coms-lan/audit";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("appendAuditEvent", () => {
  it("writes append-only JSONL audit events", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-audit-"));
    tempDirs.push(root);
    const path = join(root, "audit.log.jsonl");

    await appendAuditEvent(path, "hub_start", { node_id: "node-1" });
    await appendAuditEvent(path, "discovery_seen", { node_id: "node-2" });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "hub_start",
      node_id: "node-1",
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      event: "discovery_seen",
      node_id: "node-2",
    });
  });

  it("rejects sensitive field names", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-audit-"));
    tempDirs.push(root);

    await expect(
      appendAuditEvent(join(root, "audit.log.jsonl"), "message_inbound", {
        prompt: "secret payload",
      })
    ).rejects.toThrow(/sensitive audit field/);
  });
});
