import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROTOCOL_VERSION,
  createChannelMessage,
  createTask,
  createTaskStatusEvent,
  defaultResponsePolicy,
  parseChannelMessage,
  parseChannelRequestState,
  transitionTask,
  type A2AOrigin,
  type ChannelMessage,
} from "../src/a2a";
import { ulid } from "../src/ulid";

const origin: A2AOrigin = { instance_id: "instance-a", name: "A", host: "host-a" };
const channelId = ulid();

function message(kind: ChannelMessage["kind"], participants = ["instance-a", "instance-b"], extra: Partial<ChannelMessage> = {}): ChannelMessage {
  return createChannelMessage({
    channel_id: channelId,
    kind,
    origin,
    participants,
    body: "hello",
    ...(extra.response_requested_from === undefined ? {} : { response_requested_from: extra.response_requested_from }),
    ...(extra.response_policy === undefined ? {} : { response_policy: extra.response_policy }),
    ...(extra.in_reply_to === undefined ? {} : { in_reply_to: extra.in_reply_to }),
  });
}

describe("asynchronous channel contract", () => {
  it("creates direct requests with all-response satisfaction", () => {
    const created = message("request");
    expect(created).toMatchObject({
      protocol_version: CHANNEL_PROTOCOL_VERSION,
      kind: "request",
      channel_id: channelId,
      sequence: 1,
      participants: ["instance-a", "instance-b"],
      response_requested_from: ["instance-b"],
      response_policy: "all",
    });
    expect(parseChannelMessage(created)).toEqual({ ok: true, value: created });
  });

  it("defaults group requests to any and permits explicit all", () => {
    const group = createChannelMessage({ channel_id: channelId, kind: "request", origin, participants: ["instance-a", "instance-c", "instance-b"], body: "identify the failure" });
    const all = createChannelMessage({ channel_id: channelId, kind: "request", origin, participants: ["instance-a", "instance-c", "instance-b"], response_policy: "all", body: "each report" });
    expect(group.response_requested_from).toEqual(["instance-b", "instance-c"]);
    expect(group.response_policy).toBe("any");
    expect(all.response_policy).toBe("all");
    expect(defaultResponsePolicy(["instance-b", "instance-c"])).toBe("any");
  });

  it("represents notes and linked responses without task or wait fields", () => {
    const request = message("request");
    const response = createChannelMessage({ channel_id: channelId, kind: "response", origin: { instance_id: "instance-b", name: "B", host: "host-b" }, participants: request.participants, in_reply_to: request.message_id, body: "healthy" });
    const note = createChannelMessage({ channel_id: channelId, kind: "note", origin, participants: request.participants, body: "deployment completed" });
    expect(response).toMatchObject({ kind: "response", in_reply_to: request.message_id });
    expect(response).not.toHaveProperty("response_policy");
    expect(response).not.toHaveProperty("task_id");
    expect(note).toMatchObject({ kind: "note" });
    expect(parseChannelMessage(note)).toEqual({ ok: true, value: note });
  });

  it("rejects incompatible versions and invalid semantic combinations", () => {
    const request = message("request");
    expect(parseChannelMessage({ ...request, protocol_version: 1 })).toEqual({ ok: false, error: "protocol_version_mismatch" });
    expect(parseChannelMessage({ ...request, task_id: ulid() })).toEqual({ ok: false, error: "channel messages do not accept task_id, context_id, or timeout_ms" });
    expect(parseChannelMessage({ ...request, participants: ["instance-a", "instance-b", "instance-c"], response_policy: "all", response_requested_from: ["instance-b", "instance-c"] })).toMatchObject({ ok: true });
    expect(parseChannelMessage({ ...request, kind: "note", response_policy: "all" })).toEqual({ ok: false, error: "note cannot carry response expectation or in_reply_to" });
    expect(parseChannelMessage({ ...request, kind: "response", in_reply_to: undefined, response_requested_from: undefined, response_policy: undefined })).toEqual({ ok: false, error: "response requires in_reply_to" });
    expect(parseChannelMessage({ ...request, kind: "request", response_requested_from: ["instance-a"], response_policy: "all" })).toEqual({ ok: false, error: "request must name unique participant responders" });
    expect(() => createChannelMessage({ channel_id: channelId, kind: "request", origin, participants: ["instance-a", "instance-b"], response_requested_from: ["instance-b"], response_policy: "any", body: "bad" })).toThrow("single-recipient");
  });

  it("parses persisted satisfaction state and retains independent tasks", () => {
    const request = message("request");
    expect(parseChannelRequestState({
      protocol_version: CHANNEL_PROTOCOL_VERSION,
      channel_id: channelId,
      request_message_id: request.message_id,
      origin_instance_id: origin.instance_id,
      response_requested_from: ["instance-b"],
      response_policy: "all",
      responders_received: ["instance-b"],
      state: "satisfied",
    })).toMatchObject({ ok: true });
    const task = createTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
    expect(task.protocol_version).toBe(1);
    expect(createTaskStatusEvent(task, "working").protocol_version).toBe(1);
  });

  it("keeps the independent task transition contract", () => {
    expect(transitionTask("submitted", "working")).toEqual({ ok: true, state: "working" });
    expect(transitionTask("completed", "working")).toEqual({ ok: false, error: "terminal_immutable" });
  });
});
