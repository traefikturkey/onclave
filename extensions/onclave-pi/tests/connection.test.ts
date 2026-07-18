import { describe, expect, it, vi } from "vitest";
import { BrokerLink, type ConnectionLike, type ConnectionState } from "../src/lib/connection";

type FakeConnection = ConnectionLike & {
  emit: (event: string) => void;
};

function fakeConnection(): FakeConnection {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    createChannel: async () => ({}),
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    close: async () => undefined,
    emit: (event) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

function waitUntil(probe: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (probe()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitUntil timed out"));
      }
    }, 5);
  });
}

describe("BrokerLink", () => {
  it("retries with backoff until connect succeeds, then reports connected", async () => {
    const states: ConnectionState[] = [];
    let attempts = 0;
    const connection = fakeConnection();
    const link = new BrokerLink({
      url: "amqp://test",
      connectFn: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connection refused");
        return connection;
      },
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async () => undefined,
      onStateChange: (state) => states.push(state),
    });
    link.start();
    await waitUntil(() => link.getState() === "connected");
    expect(attempts).toBe(3);
    expect(states).toContain("connecting");
    expect(states).toContain("disconnected");
    expect(states.at(-1)).toBe("connected");
    await link.stop();
  });

  it("reconnects and re-runs onReady after a connection close", async () => {
    const onReady = vi.fn(async () => undefined);
    const connections: FakeConnection[] = [];
    const link = new BrokerLink({
      url: "amqp://test",
      connectFn: async () => {
        const connection = fakeConnection();
        connections.push(connection);
        return connection;
      },
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady,
      onStateChange: () => undefined,
    });
    link.start();
    await waitUntil(() => link.getState() === "connected");
    expect(onReady).toHaveBeenCalledTimes(1);

    connections[0].emit("close");
    await waitUntil(() => link.getState() === "disconnected" || onReady.mock.calls.length > 1);
    await waitUntil(() => link.getState() === "connected");
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(connections).toHaveLength(2);
    await link.stop();
  });

  it("treats onReady failure as a failed connection and retries", async () => {
    let readyAttempts = 0;
    const link = new BrokerLink({
      url: "amqp://test",
      connectFn: async () => fakeConnection(),
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async () => {
        readyAttempts += 1;
        if (readyAttempts < 2) throw new Error("register rejected");
      },
      onStateChange: () => undefined,
    });
    link.start();
    await waitUntil(() => link.getState() === "connected");
    expect(readyAttempts).toBe(2);
    await link.stop();
  });

  it("stops cleanly and never reconnects after stop", async () => {
    const connection = fakeConnection();
    const closeSpy = vi.spyOn(connection, "close");
    let attempts = 0;
    const link = new BrokerLink({
      url: "amqp://test",
      connectFn: async () => {
        attempts += 1;
        return connection;
      },
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async () => undefined,
    });
    link.start();
    await waitUntil(() => link.getState() === "connected");
    await link.stop();
    expect(link.getState()).toBe("closed");
    expect(closeSpy).toHaveBeenCalled();
    connection.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(1);
    expect(link.getState()).toBe("closed");
  });
});
