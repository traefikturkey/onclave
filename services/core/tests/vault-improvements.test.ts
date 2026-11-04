import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultRouteHandlers } from "../src/vault/routes";
import type { VaultRouteDependencies } from "../src/vault/routes";
import { PostgresRepository, type SqlClient } from "../src/vault/storage";

describe("improvement record API and storage", () => {
  const database = new PGlite();
  const client: SqlClient = {
    async query(text, values) {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const repository = new PostgresRepository(client);
  const record = { id: "improve-1", kind: "knowledge" as const, project: "onclave", body: "# Keep Markdown\n\nSearchable broker note.", source_ids: ["legacy:42"], source_paths: ["old/notes.md"], provenance: { import_context: "historical", machine_id: null } };
  const handlers = createVaultRouteHandlers({ repository } as unknown as VaultRouteDependencies);
  const request = (body: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}) => ({ body: Buffer.from(JSON.stringify(body)), params, query, keyId: "test" });
  const json = (response: unknown): unknown => (response as { json: unknown }).json;

  beforeAll(async () => {
    const migration = await readFile(new URL("../src/vault/migrations/20260723_improvement_records.sql", import.meta.url), "utf8");
    await database.exec(migration);
  });
  afterAll(async () => { await database.close(); });

  it("creates, gets, lists, and searches while exact retry is idempotent and conflicting reuse is explicit", async () => {
    const created = await handlers.improvementsCreate!(request(record));
    expect(created.status).toBe(201);
    expect((json(created) as typeof record).body).toBe(record.body);
    const retry = await handlers.improvementsCreate!(request(record));
    expect(retry.status).toBe(201);
    const collision = await handlers.improvementsCreate!(request({ ...record, body: "different" }));
    expect(collision.status).toBe(409);
    expect(json(collision)).toEqual({ error: "record_id_conflict", id: record.id });
    const fetched = await handlers.improvementsGet!(request(null, { record_id: record.id }));
    expect((json(fetched) as typeof record).body).toBe(record.body);
    const listed = await handlers.improvementsList!(request(null, {}, { q: "broker note", kind: "knowledge", project: "onclave" }));
    expect(json(listed)).toMatchObject({ total: 1, items: [{ id: record.id }] });
  });

  it("updates the expected revision and returns an explicit stale-revision conflict", async () => {
    const update = { expected_revision: 1, kind: "review", project: "onclave", body: "Updated **Markdown**", source_ids: ["legacy:42"], source_paths: ["old/notes.md"] };
    const updated = await handlers.improvementsUpdate!(request(update, { record_id: record.id }));
    expect(updated.status).toBe(200);
    expect(json(updated)).toMatchObject({ body: update.body, revision: 2, provenance: record.provenance });
    const stale = await handlers.improvementsUpdate!(request(update, { record_id: record.id }));
    expect(stale.status).toBe(409);
    expect(json(stale)).toEqual({ error: "revision_conflict", expected_revision: 1, current_revision: 2 });
  });
});
