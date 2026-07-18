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

export type GatewayTask = {
  taskId: string;
  state: string;
  progress?: number;
  note?: string;
  result?: unknown;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
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

export type GatewaySessionOptions = {
  events?: string;
  subscriptionId?: string;
  correlationId?: string;
  taskId?: string;
};

export type CapabilityRequest = {
  requestId: string;
  nonce: string;
};

export class OnclaveGatewayError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "OnclaveGatewayError";
  }
}

export class OnclaveGatewayClient {
  private readonly fetchImpl: FetchLike;
  private readonly webSocketImpl: WebSocketLike;
  private readonly baseUrl: string;

  constructor(options: GatewayClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:") throw new Error("Onclave gateway URL must use HTTPS");
    if (parsed.username || parsed.password) throw new Error("Onclave gateway URL must not contain credentials");
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

  async requestCapabilities(token: string, agentId: string): Promise<CapabilityRequest> {
    const response = await this.request(`/v1/agents/${encodeURIComponent(agentId)}/capabilities/request`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const value = (await response.json()) as Partial<CapabilityRequest>;
    if (typeof value.requestId !== "string" || typeof value.nonce !== "string") {
      throw new OnclaveGatewayError(response.status, "gateway response did not contain a capability request");
    }
    return { requestId: value.requestId, nonce: value.nonce };
  }

  async acceptCapabilities(
    token: string,
    agentId: string,
    request: CapabilityRequest,
    capabilities: string[],
  ): Promise<string[]> {
    await this.request(`/v1/agents/${encodeURIComponent(agentId)}/capabilities`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...request, capabilities }),
    });
    return [...capabilities];
  }

  async submitCommand(token: string, command: GatewayCommand): Promise<GatewayTask> {
    const response = await this.request("/v1/commands", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(command),
    });
    return normalizeTask(await response.json());
  }

  async getTask(token: string, taskId: string): Promise<GatewayTask> {
    const response = await this.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return normalizeTask(await response.json());
  }

  async cancelTask(token: string, taskId: string, reason?: string): Promise<GatewayTask> {
    await this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(reason ? { reason } : {}),
    });
    return this.getTask(token, taskId);
  }

  async failTask(token: string, taskId: string, result: Record<string, unknown> = {}): Promise<void> {
    await this.request(`/v1/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ result }),
    });
  }

  connectSession(agentId: string, token: string, onMessage: (message: GatewaySessionMessage) => void, options: GatewaySessionOptions = {}): WebSocket {
    const url = new URL(`/v1/agents/${encodeURIComponent(agentId)}/session`, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (options.events) url.searchParams.set("events", options.events);
    if (options.subscriptionId) url.searchParams.set("subscriptionId", options.subscriptionId);
    if (options.correlationId) url.searchParams.set("correlationId", options.correlationId);
    if (options.taskId) url.searchParams.set("taskId", options.taskId);
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
      const body = await response.text();
      let message = body || `gateway request failed with status ${response.status}`;
      let code: string | undefined;
      try {
        const value = JSON.parse(body) as { error?: unknown; code?: unknown };
        if (typeof value.error === "string") message = value.error;
        if (typeof value.code === "string") code = value.code;
      } catch {
        // Preserve plain-text gateway diagnostics.
      }
      throw new OnclaveGatewayError(response.status, message, code);
    }
    return response;
  }
}

function normalizeTask(value: unknown): GatewayTask {
  if (!value || typeof value !== "object") throw new Error("gateway response did not contain task metadata");
  const task = value as Record<string, unknown>;
  if (typeof task.taskId !== "string" || typeof task.state !== "string") {
    throw new Error("gateway response did not contain task metadata");
  }
  return { ...task, taskId: task.taskId, state: task.state };
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("gateway private key must be 32 bytes of hex");
  return Uint8Array.from(Buffer.from(value, "hex"));
}
