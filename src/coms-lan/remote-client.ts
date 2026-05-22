import { randomBytes } from "node:crypto";
import { signHandshakePayload, type HandshakePayload } from "./handshake";
import type { LocalAgent } from "./local-registry";
import type {
  ClientAuthFrame,
  HubFrame,
  HubFrameResponse,
  MessageResponseResult,
  SendPromptFrame,
} from "./transport";
import { sendWssFrames } from "./wss-transport";

export type RemoteHubClientIdentity = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
  publicKeyHex: string;
  privateKeyHex: string;
};

export type RemoteHubDescriptor = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
};

export type RemoteHubClientOptions = {
  identity: RemoteHubClientIdentity;
  remote: RemoteHubDescriptor;
  now: () => string;
  rejectUnauthorized?: boolean;
};

export type RemoteSendPromptInput = Omit<SendPromptFrame, "type">;

export function createRemoteHubClient(options: RemoteHubClientOptions): RemoteHubClient {
  return new RemoteHubClient(options);
}

export class RemoteHubClient {
  constructor(private readonly options: RemoteHubClientOptions) {}

  async listAgents(): Promise<LocalAgent[]> {
    const responses = await this.sendAuthenticatedFrames([{ type: "list_agents" }]);
    const agents = responses.find((response) => response.type === "agents");
    if (!agents || agents.type !== "agents") {
      throw new Error(`remote agent list failed: ${JSON.stringify(responses)}`);
    }
    return agents.agents;
  }

  async sendPrompt(input: RemoteSendPromptInput): Promise<Extract<HubFrameResponse, { type: "send_accepted" | "send_rejected" }>> {
    const responses = await this.sendAuthenticatedFrames([{ type: "send_prompt", ...input }]);
    const response = responses.find((item) => item.type === "send_accepted" || item.type === "send_rejected");
    if (!response || (response.type !== "send_accepted" && response.type !== "send_rejected")) {
      throw new Error(`remote prompt send failed: ${JSON.stringify(responses)}`);
    }
    return response;
  }

  async getResponse(msgId: string): Promise<MessageResponseResult> {
    const responses = await this.sendAuthenticatedFrames([{ type: "get_response", msgId }]);
    const response = responses.find((item) => item.type === "response");
    if (!response || response.type !== "response") {
      throw new Error(`remote response lookup failed: ${JSON.stringify(responses)}`);
    }
    return response.result;
  }

  private async sendAuthenticatedFrames(frames: HubFrame[]): Promise<HubFrameResponse[]> {
    const auth = await this.createAuthFrame();
    const responses = await sendWssFrames(this.options.remote.endpoint, [auth, ...frames], {
      rejectUnauthorized: this.options.rejectUnauthorized !== false,
      timeoutMs: 5_000,
    });
    const authResponse = responses[0];
    if (!authResponse || authResponse.type !== "auth_ok") {
      throw new Error(`remote authentication failed: ${JSON.stringify(authResponse ?? null)}`);
    }
    return responses.slice(1);
  }

  private async createAuthFrame(): Promise<ClientAuthFrame> {
    const payload: HandshakePayload = {
      protocol: "coms-lan",
      version: 1,
      client_node_id: this.options.identity.nodeId,
      server_node_id: this.options.remote.nodeId,
      client_instance_id: this.options.identity.hubInstanceId,
      server_instance_id: this.options.remote.hubInstanceId,
      client_endpoint: this.options.identity.endpoint,
      server_endpoint: this.options.remote.endpoint,
      client_nonce: randomNonce(),
      server_nonce: randomNonce(),
      timestamp: this.options.now(),
    };
    return {
      type: "client_auth",
      payload,
      publicKeyHex: this.options.identity.publicKeyHex,
      signatureHex: await signHandshakePayload(payload, this.options.identity.privateKeyHex),
    };
  }
}

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}
