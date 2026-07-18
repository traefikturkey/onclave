import type { WebSocket } from "ws";
import type { GatewaySessionMessage, OnclaveGatewayClient } from "./gateway-adapter";

export type ReferenceCommand = GatewaySessionMessage & {
  type: "command.delivery";
  taskId: string;
  messageId: string;
  payload: Record<string, unknown>;
};

export type ReferenceCommandHandler = (command: ReferenceCommand) => Promise<Record<string, unknown>>;

export class ReferenceAgentAdapter {
  private socket: WebSocket | null = null;

  constructor(
    private readonly client: OnclaveGatewayClient,
    private readonly agentId: string,
    private readonly sessionToken: string,
    private readonly handleCommand: ReferenceCommandHandler,
  ) {}

  connect(): WebSocket {
    this.socket = this.client.connectSession(this.agentId, this.sessionToken, (message) => {
      void this.handleMessage(message);
    });
    return this.socket;
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }

  private async handleMessage(message: GatewaySessionMessage): Promise<void> {
    if (message.type !== "command.delivery" || typeof message.taskId !== "string" || typeof message.messageId !== "string") return;
    const command = message as ReferenceCommand;
    this.send({ type: "task.ack", taskId: command.taskId, messageId: command.messageId });
    this.send({ type: "task.started", taskId: command.taskId, messageId: command.messageId });
    try {
      const result = await this.handleCommand(command);
      this.send({ type: "task.completed", taskId: command.taskId, messageId: command.messageId, result });
    } catch (error) {
      this.send({
        type: "task.completed",
        taskId: command.taskId,
        messageId: command.messageId,
        result: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket) throw new Error("reference adapter is not connected");
    this.socket.send(JSON.stringify(message));
  }
}
