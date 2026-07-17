import type { WebSocket } from "ws";
import type { GatewaySessionMessage, OnclaveGatewayClient } from "./gateway-adapter";

export type PiGatewayCommand = GatewaySessionMessage & {
  type: "command.delivery";
  messageId: string;
  taskId: string;
  payload?: Record<string, unknown>;
};

export class PiGatewaySession {
  private socket: WebSocket | null = null;

  constructor(
    private readonly client: OnclaveGatewayClient,
    private readonly agentId: string,
    private readonly token: string,
    private readonly onCommand: (command: PiGatewayCommand) => Promise<void>,
  ) {}

  connect(): void {
    this.socket = this.client.connectSession(this.agentId, this.token, (message) => {
      if (message.type !== "command.delivery" || typeof message.messageId !== "string" || typeof message.taskId !== "string") return;
      const command = message as PiGatewayCommand;
      this.acknowledge(command);
      void this.onCommand(command);
    });
  }

  acknowledge(command: Pick<PiGatewayCommand, "messageId" | "taskId">): void {
    this.send({ type: "task.ack", messageId: command.messageId, taskId: command.taskId });
    this.send({ type: "task.started", messageId: command.messageId, taskId: command.taskId });
  }

  complete(command: Pick<PiGatewayCommand, "messageId" | "taskId">, result: Record<string, unknown>): void {
    this.send({ type: "task.completed", messageId: command.messageId, taskId: command.taskId, result });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Pi gateway session is not connected");
    this.socket.send(JSON.stringify(message));
  }
}
