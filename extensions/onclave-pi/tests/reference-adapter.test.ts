import { describe, expect, it, vi } from "vitest";
import { ReferenceAgentAdapter } from "../src/lib/reference-adapter";

describe("ReferenceAgentAdapter", () => {
  it("acknowledges, starts, and completes delivered commands", async () => {
    const sent: string[] = [];
    const fakeSocket = {
      send: (value: string) => sent.push(value),
      close: vi.fn(),
    };
    let onMessage: ((message: any) => void) | undefined;
    const client = {
      connectSession: vi.fn((_agentId: string, _token: string, handler: (message: any) => void) => {
        onMessage = handler;
        return fakeSocket;
      }),
    };
    const adapter = new ReferenceAgentAdapter(client as never, "agent-reference", "token", async () => ({ passed: true }));

    adapter.connect();
    onMessage?.({ type: "command.delivery", messageId: "message-1", taskId: "task-1", payload: { instruction: "test" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.map((value) => JSON.parse(value).type)).toEqual(["task.ack", "task.started", "task.completed"]);
    expect(JSON.parse(sent[2]).result).toEqual({ passed: true });
    adapter.disconnect();
    expect(fakeSocket.close).toHaveBeenCalled();
  });
});
