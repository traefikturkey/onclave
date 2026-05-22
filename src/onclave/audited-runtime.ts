import type { AuditEventName, AuditMetadata } from "./audit";
import type { LocalAgentRegistration } from "./local-registry";
import type { DeliveredPrompt, MessageResponse } from "./messages";

export type AuditedHubRuntimeOptions = {
  audit: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

export class AuditedHubRuntime {
  constructor(private readonly options: AuditedHubRuntimeOptions) {}

  hubStart(input: { nodeId: string; hubInstanceId: string; endpoint: string }): void {
    void this.options.audit("hub_start", {
      node_id: input.nodeId,
      hub_instance_id: input.hubInstanceId,
      endpoint: input.endpoint,
    });
  }

  hubStop(input: { nodeId: string; hubInstanceId: string }): void {
    void this.options.audit("hub_stop", {
      node_id: input.nodeId,
      hub_instance_id: input.hubInstanceId,
    });
  }

  trustLoaded(input: { count: number }): void {
    void this.options.audit("trust_loaded", {
      count: input.count,
    });
  }

  trustChanged(input: { action: string; fingerprint: string; duplicate: boolean }): void {
    void this.options.audit("trust_changed", {
      action: input.action,
      fingerprint: input.fingerprint,
      duplicate: input.duplicate,
    });
  }

  discoverySeen(input: { nodeId: string; endpoint: string; result: string }): void {
    void this.options.audit("discovery_seen", {
      node_id: input.nodeId,
      endpoint: input.endpoint,
      result: input.result,
    });
  }

  discoveryIgnored(input: { reason: string; remote?: string }): void {
    void this.options.audit("discovery_ignored", {
      reason: input.reason,
      remote: input.remote,
    });
  }

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

  authAttempt(input: { nodeId: string }): void {
    void this.options.audit("auth_attempt", {
      node_id: input.nodeId,
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
