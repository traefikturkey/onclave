import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { HubFrame, HubFrameProcessor, HubFrameResponse } from "./transport";

export type TlsMaterial = {
  cert: string;
  key: string;
};

export type WssHubServerOptions = {
  host: string;
  port: number;
  tls: TlsMaterial;
  createProcessor: () => HubFrameProcessor;
};

export type WssHubServer = {
  url: string;
  port: number;
  stop: () => void;
};

export type WssClientOptions = {
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

export async function startWssHubServer(options: WssHubServerOptions): Promise<WssHubServer> {
  const httpsServer = createServer({ cert: options.tls.cert, key: options.tls.key }, (_request, response) => {
    response.writeHead(404);
    response.end("not found");
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpsServer.on("upgrade", (request, socket, head) => {
    if (!request.url || new URL(request.url, "https://localhost").pathname !== "/v1/hub") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const processor = options.createProcessor();
      websocket.on("message", (message) => {
        void handleWebSocketMessage(websocket, processor, message);
      });
      webSocketServer.emit("connection", websocket, request);
    });
  });

  await listen(httpsServer, options.port, options.host);
  const port = boundPort(httpsServer);

  return {
    url: `wss://${endpointHost(options.host)}:${port}/v1/hub`,
    port,
    stop: () => {
      webSocketServer.close();
      httpsServer.close();
      closeActiveClients(webSocketServer);
    },
  };
}

export async function sendWssFrames(
  url: string,
  frames: HubFrame[],
  options: WssClientOptions = {}
): Promise<HubFrameResponse[]> {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolve, reject) => {
    const responses: HubFrameResponse[] = [];
    let nextFrameIndex = 0;
    const rejectUnauthorized = options.rejectUnauthorized !== false;
    const websocket = new WebSocket(url, {
      rejectUnauthorized,
      tls: { rejectUnauthorized },
    } as WebSocket.ClientOptions & { tls: { rejectUnauthorized: boolean } });
    const timeout = setTimeout(() => {
      websocket.close();
      reject(new Error("timed out waiting for WSS frame response"));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timeout);

    websocket.on("open", () => {
      sendNextFrame(websocket, frames, nextFrameIndex);
      nextFrameIndex += 1;
    });

    websocket.on("message", (data) => {
      try {
        responses.push(JSON.parse(data.toString("utf8")) as HubFrameResponse);
        if (nextFrameIndex >= frames.length) {
          cleanup();
          websocket.close();
          resolve(responses);
          return;
        }
        sendNextFrame(websocket, frames, nextFrameIndex);
        nextFrameIndex += 1;
      } catch (error) {
        cleanup();
        websocket.close();
        reject(error);
      }
    });

    websocket.on("error", (error) => {
      cleanup();
      reject(new Error(`WSS frame exchange failed: ${error.message}`));
    });
  });
}

async function handleWebSocketMessage(
  websocket: WebSocket,
  processor: HubFrameProcessor,
  message: WebSocket.RawData
): Promise<void> {
  const response = await processor.handleRaw(normalizeMessage(message));
  websocket.send(JSON.stringify(response));
}

function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function boundPort(server: HttpsServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("WSS hub server did not bind to a TCP port");
  }
  const port = (address as AddressInfo).port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("WSS hub server did not bind to a TCP port");
  }
  return port;
}

function sendNextFrame(websocket: WebSocket, frames: HubFrame[], index: number): void {
  const frame = frames[index];
  if (!frame) return;
  websocket.send(JSON.stringify(frame));
}

function normalizeMessage(message: WebSocket.RawData): string | Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (Array.isArray(message)) return Buffer.concat(message);
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  return Buffer.from(message as unknown as Uint8Array);
}

function closeActiveClients(server: WebSocketServer): void {
  for (const client of server.clients) {
    client.close();
  }
}

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}
