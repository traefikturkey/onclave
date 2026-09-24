import { createServer } from "node:http";
import type { Server } from "node:http";
import type { BrokerClient } from "./broker";
import { CORE_TOPOLOGY } from "./broker";
import { log } from "./log";
import { createObservability, type Observability } from "./observability";

export function startHealthServer(
  port: number,
  broker: BrokerClient,
  observability: Observability = createObservability(),
): Server {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ status: "ok" })}\n`);
      return;
    }

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

    if (request.method === "GET" && request.url === "/ready") {
      const status = broker.status();
      const ready = status.connected && status.topologyDeclared;
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        status: ready ? "ready" : "degraded",
        checks: { broker: ready ? "ok" : "error:unavailable" },
      })}\n`);
      return;
    }

    if (request.method === "GET" && request.url === "/metrics") {
      response.writeHead(200, { "content-type": observability.contentType });
      response.end(observability.renderMetrics());
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
