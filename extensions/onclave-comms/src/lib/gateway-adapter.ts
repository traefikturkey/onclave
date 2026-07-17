import { WebSocket } from "ws";
import { signAsync } from "@noble/ed25519";

export type GatewayCommand = {
  messageId: string;
  taskId: string;
  correlationId: string;
  sourceAgentId: string;
  targetAgentId: string;
  type: string;
  expiresAt: string;
  payload: Record<string, unknown>;
};

export type GatewayTask = GatewayCommand & {
  state: string;
  createdAt: string;
  updatedAt: string;
  progress: number;
  note?: string;
  result?: Record<string, unknown>;
};

export type GatewaySessionMessage = {
  type: string;
  taskId?: string;
  [key: string]: unknown;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type WebSocketLike = typeof WebSocket;

export type GatewayClientOptions = {
  baseUrl: string;
  fetchImpl?: FetchLike;
  webSocketImpl?: WebSocketLike;
};

export class OnclaveGatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OnclaveGatewayError";
  }
}

export class OnclaveGatewayClient {
  private readonly fetchImpl: FetchLike;
  private readonly webSocketImpl: WebSocketLike;
  private readonly baseUrl: string;

  constructor(options: GatewayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketImpl = options.webSocketImpl ?? WebSocket;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async authenticate(agentId: string, signature: string): Promise<string> {
    const response = await this.request(`/v1/agents/${encodeURIComponent(agentId)}/authenticate`, {
      method: "POST",
      body: JSON.stringify({ signature }),
    });
    const value = (await response.json()) as { sessionToken?: unknown };
    if (typeof value.sessionToken !== "string" || value.sessionToken.length === 0) {
      throw new OnclaveGatewayError(response.status, "gateway response did not contain a session token");
    }
    return value.sessionToken;
  }

  async issueChallenge(agentId: string): Promise<string> {
    const response = await this.request(`/v1/agents/${encodeURIComponent(agentId)}/challenge`, {
      method: "POST",
    });
    const value = (await response.json()) as { nonce?: unknown };
    if (typeof value.nonce !== "string" || value.nonce.length === 0) {
      throw new OnclaveGatewayError(response.status, "gateway response did not contain a challenge nonce");
    }
    return value.nonce;
  }

  async authenticateWithPrivateKey(agentId: string, privateKeyHex: string): Promise<string> {
    const nonce = await this.issueChallenge(agentId);
    const signature = await signAsync(Buffer.from(nonce, "base64"), hexToBytes(privateKeyHex));
    return this.authenticate(agentId, Buffer.from(signature).toString("base64"));
  }

  async submitCommand(token: string, command: GatewayCommand): Promise<GatewayTask> {
    const response = await this.request("/v1/commands", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(command),
    });
    return (await response.json()) as GatewayTask;
  }

  async getTask(token: string, taskId: string): Promise<GatewayTask> {
    const response = await this.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await response.json()) as GatewayTask;
  }

  connectSession(agentId: string, token: string, onMessage: (message: GatewaySessionMessage) => void): WebSocket {
    const url = new URL(`/v1/agents/${encodeURIComponent(agentId)}/session`, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new this.webSocketImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as GatewaySessionMessage;
      onMessage(message);
    });
    return socket;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new OnclaveGatewayError(response.status, await response.text());
    }
    return response;
  }
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("gateway private key must be 32 bytes of hex");
  return Uint8Array.from(Buffer.from(value, "hex"));
}
