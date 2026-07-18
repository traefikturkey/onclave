import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "../src/audit";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onclave-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendAuditEvent", () => {
  it("appends JSONL entries with timestamps", async () => {
    const path = join(dir, "audit.jsonl");
    await appendAuditEvent(path, "core_start", { amqp_url: "amqp://redacted" });
    await appendAuditEvent(path, "agent_register", { agent_id: "agent-a" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "core_start" });
    expect(JSON.parse(lines[1])).toMatchObject({ event: "agent_register", agent_id: "agent-a" });
  });

  it.each([
    ["prompt", { prompt: "secret" }],
    ["body", { body: "message body" }],
    ["nested token", { meta: { access_token: "x" } }],
    ["array nested secret", { items: [{ client_secret: "x" }] }],
  ])("rejects sensitive field %s", async (_label, metadata) => {
    const path = join(dir, "audit.jsonl");
    await expect(appendAuditEvent(path, "core_start", metadata)).rejects.toThrow(
      /sensitive audit field/
    );
  });
});
