// Reconnect state machine for the adapter's broker link. The connect function
// is injected so the machine is unit-testable without a broker.

export type ConnectionState = "disconnected" | "connecting" | "connected" | "closed";

export type ChannelLike = {
  close?: () => Promise<void>;
};

export type ConnectionLike = {
  createChannel: () => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  close: () => Promise<void>;
};

export type ConnectFn = (url: string) => Promise<ConnectionLike>;

export type BrokerLinkOptions = {
  url: string;
  connectFn: ConnectFn;
  retryBaseMs: number;
  retryMaxMs: number;
  onReady: (channel: unknown) => Promise<void>;
  onStateChange?: (state: ConnectionState, detail?: string) => void;
};

export class BrokerLink {
  private state: ConnectionState = "disconnected";
  private connection: ConnectionLike | undefined;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: BrokerLinkOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (this.state === "closed") return;
    void this.establish();
  }

  async stop(): Promise<void> {
    this.setState("closed");
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) {
      await connection.close().catch(() => undefined);
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === "closed" && state !== "closed") return;
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }

  private scheduleReconnect(detail: string): void {
    if (this.state === "closed") return;
    const delay = Math.min(this.options.retryBaseMs * 2 ** this.attempt, this.options.retryMaxMs);
    this.attempt += 1;
    this.setState("disconnected", detail);
    this.retryTimer = setTimeout(() => {
      void this.establish();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async establish(): Promise<void> {
    if (this.state === "closed") return;
    this.setState("connecting");
    try {
      const connection = await this.options.connectFn(this.options.url);
      if ((this.state as ConnectionState) === "closed") {
        await connection.close().catch(() => undefined);
        return;
      }
      this.connection = connection;
      connection.on("error", () => undefined);
      connection.on("close", () => {
        this.connection = undefined;
        this.scheduleReconnect("connection_closed");
      });
      const channel = await connection.createChannel();
      await this.options.onReady(channel);
      this.attempt = 0;
      this.setState("connected");
    } catch (error) {
      this.connection = undefined;
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }
}
