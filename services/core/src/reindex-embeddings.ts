import { pathToFileURL } from "node:url";
import { Client as MinioClient } from "minio";
import { loadVaultConfig } from "./vault/config";
import { createVaultPool } from "./vault/db";
import { createEmbeddingService, type EmbeddingClient } from "./vault/embeddings";
import type { ChunkModel, ContentMetadata } from "./vault/models";
import { PostgresRepository, S3Storage } from "./vault/storage";
import { chunkText } from "./vault/vault-service";

export type ReindexRepository = {
  list_content(options: {
    offset: number;
    limit: number;
    content_type: string;
    exclude_tags: string[];
    order_by: string;
  }): Promise<[ContentMetadata[], number]>;
  replace_content_chunks(contentId: string, chunks: ChunkModel[]): Promise<void>;
};

export type ReindexStorage = {
  download(filePath: string): Promise<Buffer>;
};

export type ReindexOptions = {
  contentType: string;
  concurrency: number;
  chunk: (text: string) => string[];
  progress?: (completed: number, total: number) => void;
};

export type ReindexResult = {
  content_type: string;
  content_count: number;
  chunk_count: number;
};

async function listAllContent(repository: ReindexRepository, contentType: string): Promise<ContentMetadata[]> {
  const contents: ContentMetadata[] = [];
  let offset = 0;
  let total = 0;
  do {
    const [page, count] = await repository.list_content({
      content_type: contentType,
      exclude_tags: [],
      limit: 1000,
      offset,
      order_by: "created_at ASC",
    });
    contents.push(...page);
    offset += page.length;
    total = count;
    if (page.length === 0) break;
  } while (offset < total);
  return contents;
}

export async function reindexEmbeddings(
  repository: ReindexRepository,
  storage: ReindexStorage,
  embeddings: EmbeddingClient,
  options: ReindexOptions,
): Promise<ReindexResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("reindex concurrency must be a positive integer");
  const contents = await listAllContent(repository, options.contentType);
  let nextIndex = 0;
  let completed = 0;
  let chunkCount = 0;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const content = contents[nextIndex];
      nextIndex += 1;
      if (content === undefined) return;
      const contentId = content.id;
      if (contentId === undefined || contentId === "") {
        failure = new Error("cannot reindex content without an ID");
        return;
      }
      try {
        const text = (await storage.download(content.file_path)).toString("utf8");
        const chunkTexts = options.chunk(text);
        if (chunkTexts.length === 0) throw new Error(`content produced no chunks: ${contentId}`);
        const vectors = await embeddings.embedBatch(chunkTexts);
        if (vectors.length !== chunkTexts.length || vectors.some((vector) => vector.length !== 1024)) {
          throw new Error(`embedding output did not match content chunks: ${contentId}`);
        }
        const chunks = chunkTexts.map((chunk, index) => ({
          content_id: contentId,
          text: chunk,
          chunk_index: index,
          embedding: vectors[index],
        }));
        await repository.replace_content_chunks(contentId, chunks);
        completed += 1;
        chunkCount += chunks.length;
        options.progress?.(completed, contents.length);
      } catch (error: unknown) {
        failure = error;
      }
    }
  };

  const workerCount = Math.min(options.concurrency, Math.max(contents.length, 1));
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failure !== undefined) throw failure;
  return { content_type: options.contentType, content_count: completed, chunk_count: chunkCount };
}

function concurrencyFromArgs(args: readonly string[]): number {
  const argument = args.find((item) => item.startsWith("--concurrency="));
  if (argument === undefined) return 4;
  const value = Number.parseInt(argument.slice("--concurrency=".length), 10);
  if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error("--concurrency must be between 1 and 16");
  return value;
}

async function main(): Promise<void> {
  const config = loadVaultConfig();
  const concurrency = concurrencyFromArgs(process.argv.slice(2));
  const pool = createVaultPool(config);
  const repository = new PostgresRepository(pool);
  const endpoint = config.s3EndpointUrl.replace(/^https?:\/\//, "");
  const [endPoint, rawPort] = endpoint.split(":");
  const storage = new S3Storage(new MinioClient({
    endPoint: endPoint ?? endpoint,
    port: Number.parseInt(rawPort ?? (config.s3Secure ? "443" : "9000"), 10),
    useSSL: config.s3Secure,
    accessKey: config.s3AccessKey,
    secretKey: config.s3SecretKey,
    region: config.s3Region,
  }), config.s3Bucket);
  const embeddings = createEmbeddingService(config);
  try {
    const result = await reindexEmbeddings(repository, storage, embeddings, {
      contentType: "youtube",
      concurrency,
      chunk: chunkText,
      progress: (completed, total) => {
        if (completed % 25 === 0 || completed === total) console.log(JSON.stringify({ completed, total }));
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    await embeddings.close();
    await pool.end();
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && import.meta.url === pathToFileURL(executedPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
