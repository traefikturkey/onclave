import { createServer } from "node:http";
import type { Server } from "node:http";
import type { BrokerClient } from "./broker";
import { CORE_TOPOLOGY } from "./broker";
import { log } from "./log";

export function startHealthServer(port: number, broker: BrokerClient): Server {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const status = broker.status();
      const body = {
        status: status.connected ? "ok" : "degraded",
        broker: {
          connected: status.connected,
          topologyDeclared: status.topologyDeclared,
          ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
        },
        topology: CORE_TOPOLOGY,
      };
      response.writeHead(status.connected ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(`${JSON.stringify(body)}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ error: "not_found" })}\n`);
  });
  server.listen(port, () => {
    log("info", "health.listening", { port });
  });
  return server;
}
