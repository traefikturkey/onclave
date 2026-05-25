import { describe, expect, it } from "bun:test";
import { assertAsyncReplyablePrompt } from "../../packages/core/src/onclave/prompt-metadata";

describe("assertAsyncReplyablePrompt", () => {
  it("accepts async messages with origin routing metadata", () => {
    expect(() =>
      assertAsyncReplyablePrompt({
        msgId: "msg-1",
        replyMode: "async_message",
        origin: {
          nodeId: "node_origin",
          hubInstanceId: "hub_origin",
          endpoint: "wss://172.30.20.50:43837/v1/hub",
          sessionId: "session-origin",
          correlationId: "corr-1",
        },
      })
    ).not.toThrow();
  });

  it("rejects pollable messages", () => {
    expect(() =>
      assertAsyncReplyablePrompt({
        msgId: "msg-2",
        replyMode: "pollable",
        origin: {
          nodeId: "node_origin",
          hubInstanceId: "hub_origin",
          endpoint: "wss://172.30.20.50:43837/v1/hub",
          sessionId: "session-origin",
          correlationId: "corr-2",
        },
      })
    ).toThrow("do not use onclave_reply");
  });

  it("rejects inbound replies", () => {
    expect(() =>
      assertAsyncReplyablePrompt({
        msgId: "msg-3",
        replyMode: "async_message",
        origin: {
          nodeId: "node_origin",
          hubInstanceId: "hub_origin",
          endpoint: "wss://172.30.20.50:43837/v1/hub",
          sessionId: "session-origin",
          correlationId: "corr-3",
          inReplyToMsgId: "msg-parent",
        },
      })
    ).toThrow("already a reply");
  });
});
