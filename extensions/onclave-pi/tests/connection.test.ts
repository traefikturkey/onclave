import { describe, expect, it, vi } from "vitest";
import { HttpLink, type ConnectionState } from "../src/lib/connection";

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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("HttpLink", () => {
  it("retries registration with backoff until it succeeds, then long-polls", async () => {
    const states: ConnectionState[] = [];
    let attempts = 0;
    const link = new HttpLink({
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("API unavailable");
      },
      poll: waitForAbort,
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

  it("re-registers after a long-poll request fails", async () => {
    const onReady = vi.fn(async () => undefined);
    let polls = 0;
    const link = new HttpLink({
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady,
      poll: async (signal) => {
        polls += 1;
        if (polls === 1) throw new Error("long poll failed");
        await waitForAbort(signal);
      },
    });

    link.start();
    await waitUntil(() => link.getState() === "connected" && onReady.mock.calls.length === 2);
    expect(polls).toBe(2);
    await link.stop();
  });

  it("aborts and awaits active registration during shutdown", async () => {
    let registrationFinished = false;
    const poll = vi.fn(waitForAbort);
    const link = new HttpLink({
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async (signal) => {
        await waitForAbort(signal);
        registrationFinished = true;
      },
      poll,
    });

    link.start();
    await waitUntil(() => link.getState() === "connecting");
    await link.stop();
    expect(registrationFinished).toBe(true);
    expect(poll).not.toHaveBeenCalled();
    expect(link.getState()).toBe("closed");
  });

  it("stops the active long poll and never reconnects after shutdown", async () => {
    let readyAttempts = 0;
    let pollFinished = false;
    const poll = vi.fn(async (signal: AbortSignal) => {
      await waitForAbort(signal);
      pollFinished = true;
    });
    const link = new HttpLink({
      retryBaseMs: 5,
      retryMaxMs: 20,
      onReady: async () => {
        readyAttempts += 1;
      },
      poll,
    });

    link.start();
    await waitUntil(() => link.getState() === "connected");
    await link.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(link.getState()).toBe("closed");
    expect(readyAttempts).toBe(1);
    expect(poll).toHaveBeenCalledOnce();
    expect(pollFinished).toBe(true);
  });
});
