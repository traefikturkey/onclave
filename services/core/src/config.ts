export type CoreConfig = {
  amqpUrl: string;
  httpPort: number;
  connectRetryBaseMs: number;
  connectRetryMaxMs: number;
};

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid port value: ${value}`);
  }
  return parsed;
}

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  return {
    amqpUrl: env.ONCLAVE_AMQP_URL ?? "amqp://onclave:onclave-dev@localhost:5672/onclave",
    httpPort: parsePort(env.ONCLAVE_HTTP_PORT, 8080),
    connectRetryBaseMs: 500,
    connectRetryMaxMs: 15000,
  };
}

export function redactAmqpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<unparseable amqp url>";
  }
}
