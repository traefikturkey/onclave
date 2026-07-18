import type { Server } from "node:net";

export type LocalServiceBinding = {
  host: string;
  port: number;
  endpoint: string;
};

export type BindLocalServiceOptions = {
  host?: string;
  preferredPort?: number;
};

const DEFAULT_HOST = "127.0.0.1";

export async function bindLocalService(
  server: Server,
  options: BindLocalServiceOptions = {}
): Promise<LocalServiceBinding> {
  const host = options.host ?? DEFAULT_HOST;
  const preferredPort = options.preferredPort;

  if (preferredPort !== undefined) {
    try {
      return await listen(server, host, preferredPort);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }

  return listen(server, host, 0);
}

async function listen(server: Server, host: string, port: number): Promise<LocalServiceBinding> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("local service did not bind to a TCP address"));
        return;
      }
      resolve({
        host,
        port: address.port,
        endpoint: `https://${endpointHost(host)}:${address.port}`,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
