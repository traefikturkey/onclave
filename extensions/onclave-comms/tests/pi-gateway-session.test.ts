import { describe, expect, it, vi } from "vitest";
import { PiGatewaySession } from "../src/lib/pi-gateway-session";

describe("PiGatewaySession", () => {
  it("maps delivered commands to ack/start/completed lifecycle messages", async () => {
    const sent: string[] = [];
    const socket = { send: (value: string) => sent.push(value), close: vi.fn() };
    let onMessage: ((message: any) => void) | undefined;
    const client = {
      connectSession: vi.fn((_agentId: string, _token: string, handler: (message: any) => void) => {
        onMessage = handler;
        return socket;
      }),
    };
    const onCommand = vi.fn(async () => undefined);
    const session = new PiGatewaySession(client as never, "agent-1", "token", onCommand);

    session.connect();
    onMessage?.({ type: "command.delivery", messageId: "message-1", taskId: "task-1", payload: { instruction: "test" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.complete({ messageId: "message-1", taskId: "task-1" }, { status: "completed" });

    expect(onCommand).toHaveBeenCalledOnce();
    expect(sent.map((value) => JSON.parse(value).type)).toEqual(["task.ack", "task.started", "task.completed"]);
    session.close();
    expect(socket.close).toHaveBeenCalled();
  });
});
