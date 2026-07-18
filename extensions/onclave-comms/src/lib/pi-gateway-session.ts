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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly processing = new Set<string>();
  private readonly accepted = new Set<string>();

  constructor(
    private readonly client: OnclaveGatewayClient,
    private readonly agentId: string,
    private readonly token: string | (() => Promise<string>),
    private readonly onCommand: (command: PiGatewayCommand) => Promise<void>,
  ) {}

  connect(): void {
    this.closed = false;
    if (typeof this.token === "string") {
      this.connectWithToken(this.token);
    } else {
      void this.refreshAndConnect();
    }
  }

  private connectWithToken(token: string): void {
    this.socket = this.client.connectSession(this.agentId, token, (message) => {
      if (message.type === "heartbeat.ack" || message.type === "session.ready") return;
      if (message.type !== "command.delivery" || typeof message.messageId !== "string" || typeof message.taskId !== "string") return;
      const command = message as PiGatewayCommand;
      const key = `${command.messageId}:${command.taskId}`;
      if (this.processing.has(key) || this.accepted.has(key)) return;
      this.processing.add(key);
      void this.process(command, key);
    });
    this.socket.on("close", () => this.scheduleReconnect());
    this.socket.on("error", () => undefined);
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.socket) this.heartbeat();
      }, 20_000);
      this.heartbeatTimer.unref?.();
    }
  }

  complete(command: Pick<PiGatewayCommand, "messageId" | "taskId">, result: Record<string, unknown>): void {
    this.send({ type: "task.completed", taskId: command.taskId, result });
  }

  fail(command: Pick<PiGatewayCommand, "messageId" | "taskId">, result: Record<string, unknown> = {}): void {
    this.send({ type: "task.failed", taskId: command.taskId, result });
  }

  progress(command: Pick<PiGatewayCommand, "taskId">, progress: number, note?: string): void {
    this.send({ type: "task.progress", taskId: command.taskId, progress, ...(note ? { note } : {}) });
  }

  heartbeat(): void {
    this.send({ type: "heartbeat" });
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.processing.clear();
    this.accepted.clear();
  }

  private async refreshAndConnect(): Promise<void> {
    if (typeof this.token === "string") return;
    try {
      const token = await this.token();
      if (!this.closed) this.connectWithToken(token);
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.socket = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, 1_000);
    this.reconnectTimer.unref?.();
  }

  private async process(command: PiGatewayCommand, key: string): Promise<void> {
    try {
      await this.onCommand(command);
      this.accepted.add(key);
      this.send({ type: "task.ack", taskId: command.taskId });
      this.send({ type: "task.started", taskId: command.taskId });
    } catch (error) {
      this.send({
        type: "task.failed",
        taskId: command.taskId,
        result: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.processing.delete(key);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Pi gateway session is not connected");
    this.socket.send(JSON.stringify(message));
  }
}
