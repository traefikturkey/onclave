import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BWS_TIMEOUT_MS = 60_000;
const BWS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const API_BASE_SECRET_KEY = "ONCLAVE_API_BASE";
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

function parseApiBase(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("Onclave BWS returned invalid JSON");
  }
  if (!Array.isArray(payload)) throw new Error("Onclave BWS returned an unsupported response");

  const secret = payload.find(
    (item): item is BwsSecret => isBwsSecret(item) && item.key === API_BASE_SECRET_KEY
  );
  const value = typeof secret?.value === "string" ? secret.value.trim() : "";
  if (value === "") throw new Error(`Onclave BWS secret ${API_BASE_SECRET_KEY} is missing`);
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

export async function loadApiBaseFromBws(
  environment: BwsEnvironment = process.env,
  runner: BwsRunner = defaultRunner
): Promise<string | undefined> {
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

  return parseApiBase(stdout);
}
