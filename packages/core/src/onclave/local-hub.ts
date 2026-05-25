import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import type { OnclavePaths } from "./state";
import { atomicWriteJson, ensureOnclaveRoot } from "./state";

export type HubState = {
  version: 1;
  nodeId: string;
  hubInstanceId: string;
  pid: number;
  endpoint: string;
  startedAt: string;
};

export type StartOrDiscoverResult = {
  state: HubState;
  started: boolean;
};

export type StartOrDiscoverOptions = {
  healthCheck: (endpoint: string) => Promise<boolean>;
  startHub: () => Promise<HubState>;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
};

const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export async function readHubState(paths: OnclavePaths): Promise<HubState | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.hubState, "utf8")) as unknown;
    return isHubState(parsed) ? parsed : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeHubState(paths: OnclavePaths, state: HubState): Promise<void> {
  await ensureOnclaveRoot(paths.root);
  await atomicWriteJson(paths.hubState, state);
}

export async function startOrDiscoverLocalHub(
  paths: OnclavePaths,
  options: StartOrDiscoverOptions
): Promise<StartOrDiscoverResult> {
  await ensureOnclaveRoot(paths.root);

  const existing = await readLiveHub(paths, options.healthCheck);
  if (existing) return { state: existing, started: false };

  const release = await acquireHubLock(paths, options);
  try {
    const afterLock = await readLiveHub(paths, options.healthCheck);
    if (afterLock) return { state: afterLock, started: false };

    const state = await options.startHub();
    assertHubState(state);
    await writeHubState(paths, state);
    return { state, started: true };
  } finally {
    await release();
  }
}

async function readLiveHub(
  paths: OnclavePaths,
  healthCheck: (endpoint: string) => Promise<boolean>
): Promise<HubState | null> {
  const state = await readHubState(paths);
  if (!state) return null;

  try {
    return (await healthCheck(state.endpoint)) ? state : null;
  } catch {
    return null;
  }
}

async function acquireHubLock(
  paths: OnclavePaths,
  options: StartOrDiscoverOptions
): Promise<() => Promise<void>> {
  const retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(paths.hubLock);
      return async () => {
        await rmdir(paths.hubLock).catch(() => undefined);
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const live = await readLiveHub(paths, options.healthCheck);
      if (live) {
        return async () => undefined;
      }
      if (Date.now() >= deadline) {
        await rm(paths.hubLock, { recursive: true, force: true });
        continue;
      }
      await sleep(retryMs);
    }
  }
}

function assertHubState(value: unknown): asserts value is HubState {
  if (!isHubState(value)) {
    throw new Error("startHub returned invalid hub state");
  }
}

function isHubState(value: unknown): value is HubState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.nodeId === "string" &&
    record.nodeId.length > 0 &&
    typeof record.hubInstanceId === "string" &&
    record.hubInstanceId.length > 0 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.endpoint === "string" &&
    /^https:\/\/[^\s]+$/.test(record.endpoint) &&
    typeof record.startedAt === "string" &&
    record.startedAt.length > 0
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
