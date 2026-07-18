import { connect } from "amqplib";
import type { Channel } from "amqplib";
import { log } from "./log";
import { redactAmqpUrl } from "./config";

export const EXCHANGE_AGENTS = "onclave.agents";
export const EXCHANGE_EVENTS = "onclave.events";
export const EXCHANGE_DLX = "onclave.dlx";
export const QUEUE_DEAD_LETTER = "onclave.dead-letter";
export const QUEUE_CORE_RPC = "onclave.core.rpc";

export type BrokerTopology = {
  exchanges: string[];
  queues: string[];
};

export const CORE_TOPOLOGY: BrokerTopology = {
  exchanges: [EXCHANGE_AGENTS, EXCHANGE_EVENTS, EXCHANGE_DLX],
  queues: [QUEUE_DEAD_LETTER, QUEUE_CORE_RPC],
};

export type BrokerStatus = {
  connected: boolean;
  topologyDeclared: boolean;
  lastError?: string;
};

type AmqpConnection = Awaited<ReturnType<typeof connect>>;

export type BrokerClient = {
  status(): BrokerStatus;
  channel(): Channel | undefined;
  close(): Promise<void>;
};

export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
  await channel.assertExchange(EXCHANGE_EVENTS, "topic", { durable: true });
  await channel.assertExchange(EXCHANGE_DLX, "fanout", { durable: true });
  await channel.assertQueue(QUEUE_DEAD_LETTER, { durable: true });
  await channel.bindQueue(QUEUE_DEAD_LETTER, EXCHANGE_DLX, "");
  await channel.assertQueue(QUEUE_CORE_RPC, { durable: true });
}

export type BrokerOptions = {
  amqpUrl: string;
  retryBaseMs: number;
  retryMaxMs: number;
  onChannelReady?: (channel: Channel) => Promise<void>;
};

export function startBroker(options: BrokerOptions): BrokerClient {
  const status: BrokerStatus = { connected: false, topologyDeclared: false };
  let connection: AmqpConnection | undefined;
  let channel: Channel | undefined;
  let closing = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  const scheduleReconnect = (): void => {
    if (closing) {
      return;
    }
    const delay = Math.min(options.retryBaseMs * 2 ** attempt, options.retryMaxMs);
    attempt += 1;
    log("info", "broker.reconnect_scheduled", { delayMs: delay, attempt });
    retryTimer = setTimeout(() => {
      void establish();
    }, delay);
  };

  const establish = async (): Promise<void> => {
    try {
      connection = await connect(options.amqpUrl);
      connection.on("error", (error: Error) => {
        log("warn", "broker.connection_error", { message: error.message });
      });
      connection.on("close", () => {
        status.connected = false;
        status.topologyDeclared = false;
        channel = undefined;
        connection = undefined;
        if (!closing) {
          log("warn", "broker.connection_closed", {});
          scheduleReconnect();
        }
      });
      channel = await connection.createChannel();
      await declareTopology(channel);
      status.connected = true;
      status.topologyDeclared = true;
      status.lastError = undefined;
      attempt = 0;
      log("info", "broker.connected", {
        url: redactAmqpUrl(options.amqpUrl),
        exchanges: CORE_TOPOLOGY.exchanges,
        queues: CORE_TOPOLOGY.queues,
      });
      if (options.onChannelReady !== undefined) {
        await options.onChannelReady(channel);
      }
    } catch (error) {
      status.connected = false;
      status.topologyDeclared = false;
      status.lastError = error instanceof Error ? error.message : String(error);
      log("warn", "broker.connect_failed", { message: status.lastError });
      scheduleReconnect();
    }
  };

  void establish();

  return {
    status: () => ({ ...status }),
    channel: () => channel,
    close: async () => {
      closing = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      if (connection !== undefined) {
        await connection.close();
      }
    },
  };
}
