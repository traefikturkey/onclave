import { randomBytes } from "node:crypto";
import type { AuditEventName, AuditMetadata } from "./audit";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import {
  signHandshakePayload,
  verifyServerHandshake,
  type HandshakePayload,
  type ServerHelloFrame,
} from "./handshake";
import type { LocalAgent } from "./local-registry";
import type {
  ClientAuthFrame,
  HubFrame,
  HubFrameResponse,
  MessageResponseResult,
  SendPromptFrame,
} from "./transport";
import { sendAuthenticatedWssFrames } from "./wss-transport";

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
  authorizedKeys: AuthorizedSshEd25519Key[];
  remote: RemoteHubDescriptor;
  now: () => string;
  rejectUnauthorized?: boolean;
  audit?: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

export type RemoteSendPromptInput = Omit<SendPromptFrame, "type">;

export class RemoteHubAuthError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = "RemoteHubAuthError";
  }
}

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
    void this.options.audit?.("message_outbound", {
      msg_id: input.msgId,
      target_session_id: input.targetSessionId,
      node_id: this.options.remote.nodeId,
      status: response.type === "send_accepted" ? response.status : response.error,
    });
    return response;
  }

  async getResponse(msgId: string): Promise<MessageResponseResult> {
    const responses = await this.sendAuthenticatedFrames([{ type: "get_response", msgId }]);
    const response = responses.find((item) => item.type === "response");
    if (!response || response.type !== "response") {
      throw new Error(`remote response lookup failed: ${JSON.stringify(responses)}`);
    }
    void this.options.audit?.("response_inbound", {
      msg_id: msgId,
      node_id: this.options.remote.nodeId,
      status: response.result.status,
    });
    return response.result;
  }

  private async sendAuthenticatedFrames(frames: HubFrame[]): Promise<HubFrameResponse[]> {
    void this.options.audit?.("auth_attempt", { node_id: this.options.remote.nodeId });
    let authPayload: HandshakePayload | null = null;
    const responses = await sendAuthenticatedWssFrames(this.options.remote.endpoint, {
      createAuthFrame: async (hello) => {
        const frame = await this.createAuthFrame(hello);
        authPayload = frame.payload;
        return frame;
      },
      frames,
      rejectUnauthorized: this.options.rejectUnauthorized !== false,
      timeoutMs: 5_000,
    });

    const hello = responses[0];
    const authResponse = responses[1];
    if (!hello || hello.type !== "server_hello") {
      void this.options.audit?.("auth_failure", {
        node_id: this.options.remote.nodeId,
        reason: "missing_server_hello",
      });
      throw new RemoteHubAuthError(`remote authentication failed: ${JSON.stringify(hello ?? null)}`, "missing_server_hello");
    }
    if (!authResponse || authResponse.type !== "auth_ok") {
      const reason = authResponse?.type === "auth_failed" ? authResponse.reason : "unexpected_response";
      void this.options.audit?.("auth_failure", {
        node_id: this.options.remote.nodeId,
        reason,
      });
      throw new RemoteHubAuthError(`remote authentication failed: ${JSON.stringify(authResponse ?? null)}`, reason);
    }

    if (!authPayload) {
      throw new RemoteHubAuthError("remote authentication failed", "missing_auth_payload");
    }

    const verification = await verifyServerHandshake({
      payload: authPayload,
      signatureHex: authResponse.signatureHex,
      publicKeyHex: authResponse.publicKeyHex,
      authorizedKeys: this.options.authorizedKeys,
      now: new Date(this.options.now()),
      maxSkewMs: 30_000,
      expectedServer: {
        nodeId: this.options.remote.nodeId,
        hubInstanceId: this.options.remote.hubInstanceId,
        endpoint: hello.hello.server_endpoint,
      },
    });
    if (!verification.ok) {
      void this.options.audit?.("auth_failure", {
        node_id: this.options.remote.nodeId,
        reason: verification.reason,
      });
      throw new RemoteHubAuthError("remote server verification failed", verification.reason);
    }

    void this.options.audit?.("auth_success", {
      node_id: this.options.remote.nodeId,
      fingerprint: verification.fingerprint,
    });
    return responses.slice(2);
  }

  private async createAuthFrame(hello: ServerHelloFrame): Promise<ClientAuthFrame> {
    const payload = await this.createHandshakePayload(hello);
    return {
      type: "client_auth",
      payload,
      publicKeyHex: this.options.identity.publicKeyHex,
      signatureHex: await signHandshakePayload(payload, this.options.identity.privateKeyHex),
    };
  }

  private async createHandshakePayload(hello: ServerHelloFrame): Promise<HandshakePayload> {
    return {
      protocol: "onclave",
      version: 1,
      client_node_id: this.options.identity.nodeId,
      server_node_id: hello.hello.server_node_id,
      client_instance_id: this.options.identity.hubInstanceId,
      server_instance_id: hello.hello.server_instance_id,
      client_endpoint: this.options.identity.endpoint,
      server_endpoint: hello.hello.server_endpoint,
      client_nonce: randomNonce(),
      server_nonce: hello.hello.server_nonce,
      client_timestamp: this.options.now(),
      server_timestamp: hello.hello.server_timestamp,
    };
  }
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}
