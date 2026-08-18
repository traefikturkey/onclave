import { describe, expect, it } from "vitest";
import { loadVaultConfig } from "../src/vault/config";
import { DataTier, JobStatus, type ContentMetadata, type PipelineJob } from "../src/vault/models";
import { PostgresRepository, type SqlClient } from "../src/vault/storage";

type Call = { text: string; values: unknown[] | undefined };

class FakeClient implements SqlClient {
  readonly calls: Call[] = [];
  private readonly responses: { rows: Record<string, unknown>[]; rowCount: number | null }[];

  constructor(...responses: { rows: Record<string, unknown>[]; rowCount?: number | null }[]) {
    this.responses = responses.map((response) => ({ rows: response.rows, rowCount: response.rowCount ?? response.rows.length }));
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.calls.push({ text, values });
    return this.responses.shift() ?? { rows: [], rowCount: 0 };
  }
}

const content: ContentMetadata = {
  id: "content-1",
  content_type: "youtube",
  title: "Example",
  description: "Description",
  mime_type: "text/plain",
  file_size: 42,
  file_path: "youtube/content-1.txt",
  author: "Author",
  tags: ["video"],
  tier: "A",
  metadata: { video_id: "abc" },
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};

const contentColumns = "id, content_type, title, description, mime_type, file_size, file_path, author, tags, tier, metadata, created_at, updated_at";

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ONCLAVE_VAULT_POSTGRES_PASSWORD: "postgres-secret",
    ONCLAVE_VAULT_S3_ACCESS_KEY: "access",
    ONCLAVE_VAULT_S3_SECRET_KEY: "secret",
    ONCLAVE_VAULT_WEBSHARE_PROXY_USERNAME: "proxy-user",
    ONCLAVE_VAULT_WEBSHARE_PROXY_PASSWORD: "proxy-password",
    ...overrides,
  };
}

describe("vault storage repository", () => {
  it("preserves content list filters, default test exclusion, ordering, and pagination", async () => {
    const client = new FakeClient({ rows: [{ count: "1" }] }, { rows: [content] });
    const repository = new PostgresRepository(client);

    const [items, total] = await repository.list_content({ content_type: "youtube", limit: 25, offset: 50, exclude_tags: ["test", "private"] });

    expect(items).toHaveLength(1);
    expect(total).toBe(1);
    expect(client.calls).toEqual([
      { text: "SELECT count(*) AS count FROM content WHERE content_type = $1 AND NOT tags && $2", values: ["youtube", ["test", "private"]] },
      { text: `SELECT ${contentColumns} FROM content WHERE content_type = $1 AND NOT tags && $2 ORDER BY created_at DESC, id ASC LIMIT $3 OFFSET $4`, values: ["youtube", ["test", "private"], 25, 50] },
    ]);
  });

  it("gets content detail", async () => {
    const client = new FakeClient({ rows: [content] });
    const result = await new PostgresRepository(client).get_content("content-1");
    expect(result?.id).toBe("content-1");
    expect(client.calls).toEqual([{ text: `SELECT ${contentColumns} FROM content WHERE id = $1`, values: ["content-1"] }]);
  });

  it("creates content with its persisted fields", async () => {
    const client = new FakeClient({ rows: [content] });
    await new PostgresRepository(client).create_content(content);
    expect(client.calls[0]?.text).toBe(`INSERT INTO content (${contentColumns})\n            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\n            RETURNING ${contentColumns}`);
    expect(client.calls[0]?.values?.slice(0, 11)).toEqual(["content-1", "youtube", "Example", "Description", "text/plain", 42, "youtube/content-1.txt", "Author", ["video"], "A", { video_id: "abc" }]);
  });

  it("creates annotation content using the ordinary content insert", async () => {
    const annotation: ContentMetadata = { ...content, id: "annotation-1", content_type: "annotation", metadata: { parent_content_id: "content-1" } };
    const client = new FakeClient({ rows: [annotation] });
    await new PostgresRepository(client).create_content(annotation);
    expect(client.calls[0]?.values?.slice(0, 3)).toEqual(["annotation-1", "annotation", "Example"]);
    expect(client.calls[0]?.text).toContain("INSERT INTO content");
  });

  it("inserts chunks with pgvector literals", async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.5);
    const client = new FakeClient({ rows: [{ id: "chunk-1", content_id: "content-1", text: "chunk", chunk_index: 0, embedding: "[0.5]", created_at: new Date() }] });
    await new PostgresRepository(client).create_chunk({ id: "chunk-1", content_id: "content-1", text: "chunk", chunk_index: 0, embedding });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe("INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at)\n            VALUES ($1,$2,$3,$4,$5::vector,$6)\n            RETURNING id,content_id,text,chunk_index,embedding::text AS embedding,created_at");
    expect(client.calls[0]?.values?.slice(0, 4)).toEqual(["chunk-1", "content-1", "chunk", 0]);
    expect(client.calls[0]?.values?.[4]).toMatch(/^\[0\.5/);
  });

  it("preserves semantic search vector SQL and filter parameters", async () => {
    const embedding = Array.from({ length: 1024 }, () => 1);
    const client = new FakeClient({ rows: [] });
    await new PostgresRepository(client).vector_search(embedding, 10, { content_type: "youtube", tags: ["video"], exclude_tags: ["test"], valid_tiers: ["S", "A"], minimum_score: 0.7 });
    expect(client.calls).toEqual([{ text: "SELECT ch.text,ch.content_id,c.title,c.content_type,1 - (ch.embedding <=> $1::vector) AS score\n            FROM chunk ch JOIN content c ON c.id=ch.content_id\n            WHERE ch.embedding IS NOT NULL AND c.content_type=$2 AND c.tags && $3 AND NOT c.tags && $4 AND c.tier = ANY($5) AND 1 - (ch.embedding <=> $6::vector) > $7 ORDER BY score DESC,ch.id ASC LIMIT $8", values: [expect.any(String), "youtube", ["video"], ["test"], ["S", "A"], expect.any(String), 0.7, 10] }]);
  });

  it("creates, updates, gets, and lists pipeline jobs", async () => {
    const job: PipelineJob = { id: "job-1", resource_key: "video:abc", content_id: "content-1", status: JobStatus.PENDING, pipeline_version: "1.0.0", data_tier: DataTier.COMPACT, metadata: {} };
    const client = new FakeClient({ rows: [job] }, { rows: [job] }, { rows: [job] }, { rows: [{ count: "1" }] }, { rows: [job] });
    const repository = new PostgresRepository(client);
    await repository.create_pipeline_job(job);
    await repository.update_pipeline_job("job-1", JobStatus.PROCESSING, [new Date("2026-01-02T00:00:00.000Z"), undefined], [undefined, undefined, undefined]);
    await repository.get_pipeline_job("job-1");
    await repository.list_pipeline_jobs("content-1", JobStatus.PENDING, 10, 5);
    expect(client.calls).toEqual([
      { text: "INSERT INTO pipeline_job(id,resource_key,content_id,status,pipeline_version,data_tier, error_code,error_message,error_stage,metadata,created_at,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *", values: ["job-1", "video:abc", "content-1", "pending", "1.0.0", "compact", null, null, null, {}, null, null, null] },
      { text: "UPDATE pipeline_job SET status=$1,started_at=coalesce($2,started_at), finished_at=coalesce($3,finished_at),error_code=coalesce($4,error_code), error_message=coalesce($5,error_message),error_stage=coalesce($6,error_stage) WHERE id=$7 RETURNING *", values: ["processing", new Date("2026-01-02T00:00:00.000Z"), null, null, null, null, "job-1"] },
      { text: "SELECT * FROM pipeline_job WHERE id=$1", values: ["job-1"] },
      { text: "SELECT count(*) AS count FROM pipeline_job WHERE content_id=$1 AND status=$2", values: ["content-1", "pending"] },
      { text: "SELECT * FROM pipeline_job WHERE content_id=$1 AND status=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4", values: ["content-1", "pending", 10, 5] },
    ]);
  });

  it("inserts and queries LLM usage with optional filters", async () => {
    const client = new FakeClient({ rows: [] }, { rows: [{ total_calls: "1" }] }, { rows: [{ provider: "openrouter" }] });
    const repository = new PostgresRepository(client);
    await repository.record_llm_usage({ provider: "openrouter", model: "model", input_tokens: 1, output_tokens: 2, input_price_per_million: 3, output_price_per_million: 4, estimated_cost: 5, context: "pipeline:job-1", duration_ms: 6 });
    await repository.usage_totals(undefined, undefined, "openrouter", "model");
    await repository.usage_breakdown(undefined, undefined, "openrouter", "model");
    expect(client.calls[0]?.text).toBe("INSERT INTO llm_usage(id,provider,model,input_tokens,output_tokens,input_price_per_million, output_price_per_million,estimated_cost,context,duration_ms,pricing_snapshot_refreshed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)");
    expect(client.calls[0]?.values?.slice(1)).toEqual(["openrouter", "model", 1, 2, 3, 4, 5, "pipeline:job-1", 6, null]);
    expect(client.calls.slice(1)).toEqual([
      { text: "SELECT count(*) AS total_calls,coalesce(sum(input_tokens),0) AS total_input_tokens,coalesce(sum(output_tokens),0) AS total_output_tokens,coalesce(sum(estimated_cost),0) AS estimated_total_cost FROM llm_usage WHERE provider = $1 AND model = $2", values: ["openrouter", "model"] },
      { text: "SELECT provider,model,count(*) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(estimated_cost) AS estimated_cost FROM llm_usage WHERE provider = $1 AND model = $2 GROUP BY provider,model ORDER BY estimated_cost DESC,provider,model", values: ["openrouter", "model"] },
    ]);
  });

  it("deletes content without changing schema semantics", async () => {
    const client = new FakeClient({ rows: [], rowCount: 1 });
    await new PostgresRepository(client).delete_content("content-1");
    expect(client.calls).toEqual([{ text: "DELETE FROM content WHERE id = $1", values: ["content-1"] }]);
  });

  it("atomically replaces content chunks", async () => {
    const calls: Call[] = [];
    let released = false;
    const transaction = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
      release: () => {
        released = true;
      },
    };
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => transaction,
    };
    const embedding = Array.from({ length: 1024 }, () => 0.5);

    await new PostgresRepository(pool).replace_content_chunks("content-1", [
      { content_id: "content-1", text: "replacement", chunk_index: 0, embedding },
    ]);

    expect(calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "DELETE FROM chunk WHERE content_id=$1",
      "INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at) VALUES ($1,$2,$3,$4,$5::vector,$6)",
      "COMMIT",
    ]);
    expect(released).toBe(true);
  });
});

describe("vault configuration", () => {
  it("uses ONCLAVE_VAULT values without legacy fallbacks", () => {
    const config = loadVaultConfig(configuredEnv({
      MENOS_POSTGRES_HOST: "menos-postgres",
      POSTGRES_HOST: "legacy-postgres",
      MENOS_S3_SECURE: "true",
      S3_SECURE: "true",
      MENOS_APP_VERSION: "menos-version",
      APP_VERSION: "legacy-version",
    }));
    expect(config.postgresHost).toBe("localhost");
    expect(config.s3Secure).toBe(false);
    expect(config.appVersion).toBe("0.1.0");
    expect(config.postgresDatabase).toBe("menos");
    expect(config.s3Bucket).toBe("menos");
  });

  it("requires canonical vault secrets", () => {
    expect(() => loadVaultConfig({})).toThrow("ONCLAVE_VAULT_POSTGRES_PASSWORD is required");
    expect(() => loadVaultConfig(configuredEnv({ ONCLAVE_VAULT_POSTGRES_PASSWORD: undefined, MENOS_POSTGRES_PASSWORD: "menos-password", POSTGRES_PASSWORD: "legacy-password" }))).toThrow("ONCLAVE_VAULT_POSTGRES_PASSWORD is required");
  });

  it("configures the embedding provider and model", () => {
    const defaults = loadVaultConfig(configuredEnv());
    expect(defaults.embeddingProvider).toBe("ollama");
    expect(defaults.embeddingModel).toBe("mxbai-embed-large");

    const openrouter = loadVaultConfig(configuredEnv({
      ONCLAVE_VAULT_EMBEDDING_PROVIDER: "openrouter",
      ONCLAVE_VAULT_EMBEDDING_MODEL: "intfloat/e5-large-v2",
    }));
    expect(openrouter.embeddingProvider).toBe("openrouter");
    expect(openrouter.embeddingModel).toBe("intfloat/e5-large-v2");
  });

  it("uses the canonical pipeline version", () => {
    expect(loadVaultConfig(configuredEnv({ ONCLAVE_VAULT_APP_VERSION: "1.2.3", MENOS_APP_VERSION: "menos-version", APP_VERSION: "legacy-version" })).appVersion).toBe("1.2.3");
  });
});
