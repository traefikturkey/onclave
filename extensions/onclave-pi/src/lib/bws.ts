import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BWS_TIMEOUT_MS = 60_000;

export const DEFAULT_BWS_PROJECT_ID = "06e2f73a-9869-40dc-b430-b48500175560";
export const DEFAULT_AMQP_ENDPOINT = "amqp://rabbitmq.ilude.com:5672/onclave";

type Environment = Record<string, string | undefined>;
type BwsRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>;

type BwsSecret = {
  key?: unknown;
  value?: unknown;
};

function serverUrl(apiServer: string): string {
  const trimmed = apiServer.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function parseSecrets(stdout: string): Map<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("Onclave BWS returned invalid JSON");
  }
  if (!Array.isArray(payload)) throw new Error("Onclave BWS returned an unsupported response");
  return new Map(
    (payload as BwsSecret[])
      .filter((item) => typeof item.key === "string" && typeof item.value === "string")
      .map((item) => [item.key as string, item.value as string])
  );
}

function buildBrokerUrl(endpoint: string, secrets: Map<string, string>): string {
  const username = secrets.get("RABBITMQ_DEFAULT_USER")?.trim();
  const password = secrets.get("RABBITMQ_DEFAULT_PASS");
  if (!username) throw new Error("Onclave BWS secret RABBITMQ_DEFAULT_USER is missing");
  if (!password) throw new Error("Onclave BWS secret RABBITMQ_DEFAULT_PASS is missing");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ONCLAVE_AMQP_ENDPOINT is not a valid URL");
  }
  if (url.protocol !== "amqp:" && url.protocol !== "amqps:") {
    throw new Error("ONCLAVE_AMQP_ENDPOINT must use amqp or amqps");
  }
  if (url.username || url.password) {
    throw new Error("ONCLAVE_AMQP_ENDPOINT must not contain credentials");
  }
  url.username = username;
  url.password = password;
  return url.toString();
}

async function defaultRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<{ stdout: string }> {
  const result = await execFile(command, args, options);
  return { stdout: result.stdout };
}

export async function loadBrokerUrlFromBws(
  environment: Environment = process.env,
  runner: BwsRunner = defaultRunner
): Promise<string | undefined> {
  const accessToken = environment.BITWARDEN_ACCESS_KEY?.trim();
  if (!accessToken) return undefined;

  const projectId = environment.ONCLAVE_BWS_PROJECT_ID?.trim() || DEFAULT_BWS_PROJECT_ID;
  const endpoint = environment.ONCLAVE_AMQP_ENDPOINT?.trim() || DEFAULT_AMQP_ENDPOINT;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    BWS_ACCESS_TOKEN: accessToken,
  };
  const apiServer = environment.BITWARDEN_API_SERVER?.trim();
  if (apiServer) childEnvironment.BWS_SERVER_URL = serverUrl(apiServer);

  let stdout: string;
  try {
    ({ stdout } = await runner(
      "bws",
      ["secret", "list", projectId, "--output", "json"],
      {
        env: childEnvironment,
        timeout: BWS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      }
    ));
  } catch {
    throw new Error("Onclave could not read its Bitwarden Secrets Manager project");
  }
  return buildBrokerUrl(endpoint, parseSecrets(stdout));
}
