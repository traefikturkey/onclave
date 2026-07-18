import { describe, expect, it, vi } from "vitest";
import { PiGatewaySession } from "../src/lib/pi-gateway-session";

describe("PiGatewaySession", () => {
  it("acknowledges only after the host accepts a command and ignores duplicates", async () => {
    const sent: string[] = [];
    const socket = { send: (value: string) => sent.push(value), close: vi.fn(), on: vi.fn() };
    let onMessage: ((message: any) => void) | undefined;
    const client = {
      connectSession: vi.fn((_agentId: string, _token: string, handler: (message: any) => void) => {
        onMessage = handler;
        return socket;
      }),
    };
    let accept!: () => void;
    const onCommand = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    const session = new PiGatewaySession(client as never, "agent-1", "token", onCommand);

    session.connect();
    onMessage?.({ type: "command.delivery", messageId: "message-1", taskId: "task-1", payload: { instruction: "test" } });
    onMessage?.({ type: "command.delivery", messageId: "message-1", taskId: "task-1", payload: { instruction: "test" } });

    expect(sent).toHaveLength(0);
    expect(onCommand).toHaveBeenCalledOnce();
    accept();
    await new Promise((resolve) => setTimeout(resolve, 0));

    session.complete({ messageId: "message-1", taskId: "task-1" }, { status: "completed" });
    expect(sent.map((value) => JSON.parse(value).type)).toEqual(["task.ack", "task.started", "task.completed"]);
    session.close();
    expect(socket.close).toHaveBeenCalled();
  });

  it("reports command handling failures", async () => {
    const sent: string[] = [];
    const socket = { send: (value: string) => sent.push(value), close: vi.fn(), on: vi.fn() };
    let onMessage: ((message: any) => void) | undefined;
    const client = {
      connectSession: vi.fn((_agentId: string, _token: string, handler: (message: any) => void) => {
        onMessage = handler;
        return socket;
      }),
    };
    const session = new PiGatewaySession(client as never, "agent-1", "token", async () => {
      throw new Error("host rejected command");
    });

    session.connect();
    onMessage?.({ type: "command.delivery", messageId: "message-1", taskId: "task-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(sent[0]).type).toBe("task.failed");
  });
});
