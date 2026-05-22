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
  const server = Bun.serve<{ processor: HubFrameProcessor }>({
    hostname: options.host,
    port: options.port,
    tls: options.tls,
    fetch(request, serverInstance) {
      if (new URL(request.url).pathname !== "/v1/hub") {
        return new Response("not found", { status: 404 });
      }
      if (serverInstance.upgrade(request, { data: { processor: options.createProcessor() } })) {
        return undefined;
      }
      return new Response("websocket upgrade required", { status: 426 });
    },
    websocket: {
      async message(websocket, message) {
        const response = await websocket.data.processor.handleRaw(normalizeMessage(message));
        websocket.send(JSON.stringify(response));
      },
    },
  });

  const port = Number(server.port);
  if (!Number.isInteger(port) || port <= 0) {
    server.stop(true);
    throw new Error("WSS hub server did not bind to a TCP port");
  }

  return {
    url: `wss://${endpointHost(options.host)}:${port}/v1/hub`,
    port,
    stop: () => server.stop(true),
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
    const timeout = setTimeout(() => {
      websocket.close();
      reject(new Error("timed out waiting for WSS frame response"));
    }, timeoutMs);

    const websocket = new WebSocket(url, {
      tls: { rejectUnauthorized: options.rejectUnauthorized !== false },
    } as unknown as string | string[]);

    const cleanup = () => clearTimeout(timeout);

    websocket.addEventListener("open", () => {
      sendNextFrame(websocket, frames, nextFrameIndex);
      nextFrameIndex += 1;
    });

    websocket.addEventListener("message", (event) => {
      try {
        responses.push(JSON.parse(String(event.data)) as HubFrameResponse);
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

    websocket.addEventListener("error", () => {
      cleanup();
      reject(new Error("WSS frame exchange failed"));
    });
  });
}

function sendNextFrame(websocket: WebSocket, frames: HubFrame[], index: number): void {
  const frame = frames[index];
  if (!frame) return;
  websocket.send(JSON.stringify(frame));
}

function normalizeMessage(message: string | Buffer): string | Buffer {
  return message;
}

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}
