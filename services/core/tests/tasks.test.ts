import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ulid } from "@onclave/envelope";
import { TaskStore } from "../src/tasks";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "onclave-a2a-state-"));
  return { dir, path: join(dir, "state.json") };
}

describe("TaskStore", () => {
  it("persists contexts, tasks, status events, and resumes nonterminal state", async () => {
    const { dir, path } = await fixture();
    try {
      const contextId = ulid();
      const store = new TaskStore({ path });
      const task = await store.createTrackedTask({ contextId, originInstanceId: "a", assigneeInstanceId: "b" });
      const updated = await store.updateTask(task.task_id, "working");
      expect(updated.ok).toBe(true);
      const restored = new TaskStore({ path });
      expect(await restored.load()).toEqual({ contexts: 1, tasks: 1, events: 1 });
      expect(restored.getTask(task.task_id)?.state).toBe("working");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ protocol_version: 1 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("is idempotent for repeated status events and keeps terminal tasks closed", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new TaskStore({ path });
      const task = await store.createTrackedTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
      const completed = await store.updateTask(task.task_id, "working");
      expect(completed.ok).toBe(true);
      const terminal = await store.updateTask(task.task_id, "completed", { messageId: "reply-1" });
      expect(terminal.ok).toBe(true);
      const duplicate = await store.updateTask(task.task_id, "completed", { messageId: "reply-1" });
      expect(duplicate).toMatchObject({ ok: true, duplicate: true });
      expect(await store.updateTask(task.task_id, "working")).toEqual({ ok: false, error: "terminal_immutable" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects usage that reaches the configured task budget without changing state", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new TaskStore({ path, limits: { maxTotalTokens: 10 } });
      const task = await store.createTrackedTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
      const result = await store.updateTask(task.task_id, "working", { usage: { input_tokens: 6, output_tokens: 4 } });
      expect(result).toEqual({ ok: false, error: "budget_exceeded" });
      expect(store.getTask(task.task_id)?.state).toBe("submitted");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("creates follow-up tasks in the same context without reopening the prior task", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new TaskStore({ path });
      const contextId = ulid();
      const first = await store.createTrackedTask({ contextId, originInstanceId: "a", assigneeInstanceId: "b" });
      await store.updateTask(first.task_id, "working");
      await store.updateTask(first.task_id, "completed");
      const followUp = await store.createTrackedTask({ contextId, originInstanceId: "a", assigneeInstanceId: "b", priorTaskId: first.task_id });
      expect(followUp.context_id).toBe(first.context_id);
      expect(followUp.prior_task_id).toBe(first.task_id);
      expect(store.getTask(first.task_id)?.state).toBe("completed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
