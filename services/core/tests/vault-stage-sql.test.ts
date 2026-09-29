import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initialPipelineStages, PIPELINE_STAGES } from "../src/vault/job-stages";
import { PostgresRepository, type SqlClient } from "../src/vault/storage";

// Exercise PostgreSQL JSONB predicates, not a fake that accepts every UPDATE.
// Only tables/columns touched by these stage and empty-result writes are needed.
describe("vault stage SQL", () => {
  const database = new PGlite();
  const client: SqlClient = {
    async query(text, values) {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const pool = {
    ...client,
    async connect() { return { ...client, release() {} }; },
  };
  const repository = new PostgresRepository(pool);
  const startedAt = new Date("2026-09-29T17:16:13.944Z");
  const finishedAt = new Date("2026-09-29T17:16:14.000Z");

  beforeAll(async () => {
    await database.exec(`
      CREATE TABLE pipeline_job (id text PRIMARY KEY, content_id text, status text, claim_token text, metadata jsonb);
      CREATE TABLE content (id text PRIMARY KEY, metadata jsonb, processing_status text, processed_at timestamptz, pipeline_version text, updated_at timestamptz);
      CREATE TABLE chunk (content_id text);
      CREATE TABLE content_entity (content_id text);
    `);
  });
  afterAll(async () => { await database.close(); });
  beforeEach(async () => {
    await database.exec("TRUNCATE pipeline_job, content, chunk, content_entity");
    await database.query("INSERT INTO pipeline_job VALUES ($1,$2,$3,$4,$5)", ["job-1", "content-1", "processing", "claim-1", { stages: initialPipelineStages() }]);
    await database.query("INSERT INTO content (id,metadata,processing_status) VALUES ($1,$2,$3)", ["content-1", {}, "processing"]);
  });

  it("advances stored stage objects and atomically completes the persist stage", async () => {
    for (const stage of PIPELINE_STAGES) {
      expect(await repository.transition_pipeline_job_stage("job-1", stage, "processing", [startedAt, undefined], [undefined, undefined], ["pending"], "claim-1")).toBeDefined();
      if (stage !== "persist") {
        expect(await repository.transition_pipeline_job_stage("job-1", stage, "completed", [undefined, finishedAt], [undefined, undefined], ["processing"], "claim-1")).toBeDefined();
      }
    }
    expect(await repository.complete_content_processing("content-1", { summary: "Done" }, "1.0", [], [], {
      aliases: [], entities: [], jobId: "job-1", claimToken: "claim-1", persistStageCompletedAt: finishedAt,
    })).toBe(true);
    const result = await database.query<{ metadata: { stages: Record<string, unknown> } }>("SELECT metadata FROM pipeline_job WHERE id='job-1'");
    for (const stage of PIPELINE_STAGES) {
      expect(result.rows[0]?.metadata.stages[stage]).toEqual({ status: "completed", started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString() });
    }
    expect(await repository.get_pipeline_result("content-1")).toEqual({ summary: "Done" });
  });

  it("accepts an already-processing persist object rather than comparing the object to a string", async () => {
    await database.query("UPDATE pipeline_job SET metadata=$1 WHERE id='job-1'", [{ stages: { persist: { status: "processing", started_at: startedAt.toISOString() } } }]);
    expect(await repository.complete_content_processing("content-1", { summary: "Persisted" }, "1.0", [], [], {
      aliases: [], entities: [], jobId: "job-1", claimToken: "claim-1", persistStageCompletedAt: finishedAt,
    })).toBe(true);
    expect(await repository.get_pipeline_result("content-1")).toEqual({ summary: "Persisted" });
  });

  it("still rejects stale claims and wrong stage states without publishing a result", async () => {
    expect(await repository.transition_pipeline_job_stage("job-1", "context_fetch", "processing", [startedAt, undefined], [undefined, undefined], ["pending"], "stale-claim")).toBeUndefined();
    expect(await repository.transition_pipeline_job_stage("job-1", "context_fetch", "completed", [undefined, finishedAt], [undefined, undefined], ["processing"], "claim-1")).toBeUndefined();
    // The persist stage has not started, even with the right claim.
    expect(await repository.complete_content_processing("content-1", { summary: "Premature" }, "1.0", [], [], {
      aliases: [], entities: [], jobId: "job-1", claimToken: "claim-1", persistStageCompletedAt: finishedAt,
    })).toBe(false);
    await repository.transition_pipeline_job_stage("job-1", "persist", "processing", [startedAt, undefined], [undefined, undefined], ["pending"], "claim-1");
    expect(await repository.complete_content_processing("content-1", { summary: "Stale" }, "1.0", [], [], {
      aliases: [], entities: [], jobId: "job-1", claimToken: "stale-claim", persistStageCompletedAt: finishedAt,
    })).toBe(false);
    expect(await repository.get_pipeline_result("content-1")).toBeUndefined();
  });

  it("records failed and skipped stages using their nested statuses", async () => {
    await repository.transition_pipeline_job_stage("job-1", "context_fetch", "processing", [startedAt, undefined], [undefined, undefined], ["pending"], "claim-1");
    expect(await repository.transition_pipeline_job_stage("job-1", "context_fetch", "failed", [undefined, finishedAt], ["CONTEXT_ERROR", "Context unavailable"], ["processing"], "claim-1")).toBeDefined();
    expect(await repository.transition_pipeline_job_stage("job-1", "llm_call", "skipped", [undefined, finishedAt], [undefined, undefined], ["pending"], "claim-1")).toBeDefined();
    const result = await database.query<{ metadata: unknown }>("SELECT metadata FROM pipeline_job WHERE id='job-1'");
    expect(result.rows[0]?.metadata).toMatchObject({ stages: {
      context_fetch: { status: "failed", error_code: "CONTEXT_ERROR", error_message: "Context unavailable" },
      llm_call: { status: "skipped" },
    } });
  });
});
