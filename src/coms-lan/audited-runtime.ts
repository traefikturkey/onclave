import type { AuditEventName, AuditMetadata } from "./audit";
import type { LocalAgentRegistration } from "./local-registry";
import type { DeliveredPrompt, MessageResponse } from "./messages";

export type AuditedHubRuntimeOptions = {
  audit: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

export class AuditedHubRuntime {
  constructor(private readonly options: AuditedHubRuntimeOptions) {}

  localRegister(registration: LocalAgentRegistration): void {
    void this.options.audit("local_register", {
      session_id: registration.sessionId,
      name: registration.name,
      project: registration.projectLabel,
    });
  }

  localUnregister(sessionId: string, removed: boolean): void {
    void this.options.audit("local_unregister", {
      session_id: sessionId,
      removed,
    });
  }

  messageInbound(prompt: DeliveredPrompt): void {
    void this.options.audit("message_inbound", {
      msg_id: prompt.msgId,
      target_session_id: prompt.targetSessionId,
      hops: prompt.hops,
    });
  }

  messageOutbound(input: { msgId: string; targetSessionId: string; status: string }): void {
    void this.options.audit("message_outbound", {
      msg_id: input.msgId,
      target_session_id: input.targetSessionId,
      status: input.status,
    });
  }

  responseInbound(response: MessageResponse): void {
    void this.options.audit("response_inbound", {
      msg_id: response.msgId,
      responder_session_id: response.responderSessionId,
      error: response.error,
    });
  }

  authSuccess(input: { nodeId: string; fingerprint: string }): void {
    void this.options.audit("auth_success", {
      node_id: input.nodeId,
      fingerprint: input.fingerprint,
    });
  }

  authFailure(input: { nodeId: string; reason: string }): void {
    void this.options.audit("auth_failure", {
      node_id: input.nodeId,
      reason: input.reason,
    });
  }
}
