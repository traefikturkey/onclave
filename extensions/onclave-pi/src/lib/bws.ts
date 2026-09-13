import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BWS_TIMEOUT_MS = 60_000;
const BWS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const API_BASE_SECRET_KEY = "ONCLAVE_API_BASE";
const WORKSTATION_S3_KEYS = {
  endpoint: "ONCLAVE_VAULT_S3_WORKSTATION_ENDPOINT",
  bucket: "ONCLAVE_VAULT_S3_BUCKET",
  region: "ONCLAVE_VAULT_S3_REGION",
  accessKey: "ONCLAVE_VAULT_S3_ACCESS_KEY",
  secretKey: "ONCLAVE_VAULT_S3_SECRET_KEY",
} as const;
const BWS_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BWS_OVERRIDES = new Set(["BWS_SERVER_URL", "BWS_CONFIG_FILE", "BWS_PROFILE"]);

export type BwsEnvironment = Record<string, string | undefined>;

export type BwsRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>;

type BwsSecret = {
  key?: unknown;
  value?: unknown;
};

function isBwsSecret(value: unknown): value is BwsSecret {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function bwsExecutablePath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(homeDirectory, ".local", "bin", platform === "win32" ? "bws.exe" : "bws");
}

function serverUrl(apiServer: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiServer);
  } catch {
    throw new Error("BITWARDEN_API_SERVER must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    apiServer.includes("?") ||
    apiServer.includes("#")
  ) {
    throw new Error("BITWARDEN_API_SERVER must be an HTTPS URL without userinfo, query, or fragment");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/api") ? pathname.slice(0, -4) || "/" : pathname || "/";
  return parsed.toString().replace(/\/$/, "");
}

function projectId(environment: BwsEnvironment): string {
  const value = environment.ONCLAVE_BWS_PROJECT_ID?.trim();
  if (value === undefined || value === "") {
    throw new Error("Onclave BWS bootstrap is missing ONCLAVE_BWS_PROJECT_ID");
  }
  if (!BWS_PROJECT_ID_PATTERN.test(value)) {
    throw new Error("Onclave BWS bootstrap requires a valid ONCLAVE_BWS_PROJECT_ID");
  }
  return value;
}

function childEnvironment(environment: BwsEnvironment, accessKey: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!BWS_OVERRIDES.has(name.toUpperCase())) child[name] = value;
  }
  child.BWS_ACCESS_TOKEN = accessKey;

  const apiServer = environment.BITWARDEN_API_SERVER?.trim();
  if (!apiServer) {
    throw new Error("Onclave BWS bootstrap is missing BITWARDEN_API_SERVER");
  }
  child.BWS_SERVER_URL = serverUrl(apiServer);
  return child;
}

function parseSecrets(stdout: string): Map<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("Onclave BWS returned invalid JSON");
  }
  if (!Array.isArray(payload)) throw new Error("Onclave BWS returned an unsupported response");

  const secrets = new Map<string, string>();
  for (const item of payload) {
    if (!isBwsSecret(item) || typeof item.key !== "string" || typeof item.value !== "string") continue;
    const value = item.value.trim();
    if (value !== "") secrets.set(item.key, value);
  }
  return secrets;
}

function secretValue(secrets: Map<string, string>, key: string): string {
  const value = secrets.get(key);
  if (value === undefined) throw new Error(`Onclave BWS secret ${key} is missing`);
  return value;
}

async function defaultRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<{ stdout: string }> {
  const result = await execFile(command, args, options);
  return { stdout: result.stdout };
}

async function loadBwsSecrets(
  environment: BwsEnvironment,
  runner: BwsRunner,
): Promise<Map<string, string> | undefined> {
  const accessKey = environment.BITWARDEN_ACCESS_KEY?.trim();
  if (!accessKey) return undefined;

  const bwsProjectId = projectId(environment);
  const env = childEnvironment(environment, accessKey);

  let stdout: string;
  try {
    ({ stdout } = await runner(
      bwsExecutablePath(),
      ["secret", "list", "--output", "json", "--", bwsProjectId],
      {
        env,
        timeout: BWS_TIMEOUT_MS,
        maxBuffer: BWS_MAX_BUFFER_BYTES,
      }
    ));
  } catch {
    throw new Error("Onclave could not read its Bitwarden Secrets Manager project");
  }

  return parseSecrets(stdout);
}

export async function loadApiBaseFromBws(
  environment: BwsEnvironment = process.env,
  runner: BwsRunner = defaultRunner
): Promise<string | undefined> {
  const secrets = await loadBwsSecrets(environment, runner);
  if (secrets === undefined) return undefined;
  return secretValue(secrets, API_BASE_SECRET_KEY);
}

export type WorkstationS3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
};

/** Loads the workstation-only S3 contract lazily; secret values remain in memory. */
export async function loadWorkstationS3ConfigFromBws(
  environment: BwsEnvironment = process.env,
  runner: BwsRunner = defaultRunner,
): Promise<WorkstationS3Config | undefined> {
  const secrets = await loadBwsSecrets(environment, runner);
  if (secrets === undefined) return undefined;
  const configured = Object.values(WORKSTATION_S3_KEYS).some((key) => secrets.has(key));
  if (!configured) return undefined;
  return {
    endpoint: secretValue(secrets, WORKSTATION_S3_KEYS.endpoint),
    bucket: secretValue(secrets, WORKSTATION_S3_KEYS.bucket),
    region: secretValue(secrets, WORKSTATION_S3_KEYS.region),
    accessKey: secretValue(secrets, WORKSTATION_S3_KEYS.accessKey),
    secretKey: secretValue(secrets, WORKSTATION_S3_KEYS.secretKey),
  };
}
