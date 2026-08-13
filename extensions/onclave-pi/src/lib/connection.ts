// Reconnect state machine for the adapter's HTTPS transport. Registration and
// long polling are injected so the machine is unit-testable without an API.

export type ConnectionState = "disconnected" | "connecting" | "connected" | "closed";

export type HttpLinkOptions = {
  retryBaseMs: number;
  retryMaxMs: number;
  onReady: (signal: AbortSignal) => Promise<void>;
  poll: (signal: AbortSignal) => Promise<void>;
  onStateChange?: (state: ConnectionState, detail?: string) => void;
};

export class HttpLink {
  private state: ConnectionState = "disconnected";
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private operationAbort: AbortController | undefined;
  private activeOperation: Promise<void> | undefined;

  constructor(private readonly options: HttpLinkOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  start(): void {
    this.beginEstablish();
  }

  async stop(): Promise<void> {
    this.setState("closed");
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.operationAbort?.abort();
    const activeOperation = this.activeOperation;
    if (activeOperation !== undefined) await activeOperation;
  }

  private beginEstablish(): void {
    if (this.getState() === "closed" || this.activeOperation !== undefined) return;
    const operation = Promise.resolve().then(() => this.establish());
    this.activeOperation = operation;
    void operation.then(
      () => this.clearActiveOperation(operation),
      () => this.clearActiveOperation(operation)
    );
  }

  private clearActiveOperation(operation: Promise<void>): void {
    if (this.activeOperation === operation) this.activeOperation = undefined;
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
      this.retryTimer = undefined;
      this.beginEstablish();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async establish(): Promise<void> {
    if (this.getState() === "closed") return;
    this.setState("connecting");
    const operationAbort = new AbortController();
    this.operationAbort = operationAbort;
    try {
      await this.options.onReady(operationAbort.signal);
      if (this.getState() === "closed" || operationAbort.signal.aborted) return;
      this.attempt = 0;
      this.setState("connected");
      while (this.getState() === "connected" && !operationAbort.signal.aborted) {
        await this.options.poll(operationAbort.signal);
      }
    } catch (error) {
      if (this.getState() !== "closed" && !operationAbort.signal.aborted) {
        this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.operationAbort === operationAbort) this.operationAbort = undefined;
    }
  }
}
