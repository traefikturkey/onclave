import { readFile } from "node:fs/promises";
import {
  CHANNEL_PROTOCOL_VERSION,
  LEGACY_CHANNEL_PROTOCOL_VERSION,
  createChannelMessage,
  isChannelMessageKind,
  isResponsePolicy,
  isUlid,
  normalizeParticipants,
  parseChannelMessage,
  parseChannelRequestState,
  resolveResponseExpectation,
  ulid,
  type A2AOrigin,
  type Channel,
  type ChannelMessage,
  type ChannelMessageKind,
  type ChannelRequestState,
  type ChannelSatisfaction,
  type ResponsePolicy,
} from "@onclave/envelope";
import { atomicWriteJson } from "./state";

const DEFAULT_MAX_MESSAGES = 1000;
const DEFAULT_MAX_REQUESTS = 1000;

type StoredIdempotencyKey = { key: string; message_id: string };

export type StoredChannel = Channel & {
  messages: ChannelMessage[];
  requests: ChannelRequestState[];
  idempotency_keys: StoredIdempotencyKey[];
};

type PersistedState = {
  protocol_version: number;
  channels: StoredChannel[];
};

export type ChannelStoreOptions = {
  path: string;
  now?: () => Date;
  maxMessages?: number;
  maxRequests?: number;
};

export type ChannelPostInput = {
  origin: A2AOrigin;
  kind: ChannelMessageKind;
  to?: readonly string[];
  body: string;
  channel_id?: string;
  response_policy?: ResponsePolicy;
  in_reply_to?: string;
  usage?: { input_tokens: number; output_tokens: number };
  schema?: string;
  message_id?: string;
  idempotency_key?: string;
};

export type ChannelPostResult = {
  ok: true;
  message: ChannelMessage;
  channel: StoredChannel;
  satisfaction?: ChannelSatisfaction;
  duplicate: boolean;
};

export class ChannelStore {
  private readonly channels = new Map<string, StoredChannel>();
  private readonly byParticipants = new Map<string, string>();
  private readonly messageIds = new Map<string, { channelId: string; message: ChannelMessage }>();
  private readonly idempotency = new Map<string, string>();
  private readonly now: () => Date;
  private readonly maxMessages: number;
  private readonly maxRequests: number;
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChannelStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    if (!Number.isSafeInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1) throw new Error("maxRequests must be a positive safe integer");
  }

  async load(): Promise<{ channels: number; messages: number; requests: number }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.options.path, "utf8")) as unknown;
    } catch {
      return { channels: 0, messages: 0, requests: 0 };
    }
    const migration = parsedIsLegacyState(parsed)
      ? migratePersistedState(parsed, this.maxMessages, this.maxRequests)
      : undefined;
    const state = migration ?? (isPersistedState(parsed) ? parsed : undefined);
    if (state === undefined) {
      if (isRecord(parsed) && parsed.protocol_version !== CHANNEL_PROTOCOL_VERSION && parsed.protocol_version !== LEGACY_CHANNEL_PROTOCOL_VERSION) throw new Error("protocol_version_mismatch");
      throw new Error("invalid channel state file");
    }
    this.channels.clear();
    this.byParticipants.clear();
    this.messageIds.clear();
    this.idempotency.clear();
    for (const channel of state.channels) {
      if (this.channels.has(channel.channel_id)) throw new Error("duplicate channel id");
      const key = participantKey(channel.participants);
      if (this.byParticipants.has(key)) throw new Error("duplicate channel participant set");
      this.channels.set(channel.channel_id, channel);
      this.byParticipants.set(key, channel.channel_id);
      for (const message of channel.messages) this.messageIds.set(message.message_id, { channelId: channel.channel_id, message });
      for (const entry of channel.idempotency_keys) this.idempotency.set(entry.key, entry.message_id);
    }
    if (migration !== undefined) await this.persist();
    return {
      channels: this.channels.size,
      messages: [...this.channels.values()].reduce((total, channel) => total + channel.messages.length, 0),
      requests: [...this.channels.values()].reduce((total, channel) => total + channel.requests.length, 0),
    };
  }

  getChannel(channelId: string): StoredChannel | undefined {
    const channel = this.channels.get(channelId);
    return channel === undefined ? undefined : cloneChannel(channel);
  }

  getRequest(requestMessageId: string): ChannelRequestState | undefined {
    const indexed = this.messageIds.get(requestMessageId);
    if (indexed !== undefined) {
      const request = this.channels.get(indexed.channelId)?.requests.find((candidate) => candidate.request_message_id === requestMessageId);
      if (request !== undefined) return { ...request, response_requested_from: [...request.response_requested_from], responders_received: [...request.responders_received] };
    }
    for (const channel of this.channels.values()) {
      const request = channel.requests.find((candidate) => candidate.request_message_id === requestMessageId);
      if (request !== undefined) return { ...request, response_requested_from: [...request.response_requested_from], responders_received: [...request.responders_received] };
    }
    return undefined;
  }

  listMessages(channelId: string, afterSequence = 0, limit = this.maxMessages): ChannelMessage[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive safe integer");
    return (this.channels.get(channelId)?.messages ?? [])
      .filter((message) => message.sequence > afterSequence)
      .slice(0, limit)
      .map((message) => cloneMessage(message));
  }

  listRequests(channelId: string): ChannelRequestState[] {
    return (this.channels.get(channelId)?.requests ?? []).map((request) => ({
      ...request,
      response_requested_from: [...request.response_requested_from],
      responders_received: [...request.responders_received],
    }));
  }

  async post(input: ChannelPostInput): Promise<ChannelPostResult> {
    return this.mutate(async () => this.postLocked(input));
  }

  private async postLocked(input: ChannelPostInput): Promise<ChannelPostResult> {
    validatePostInput(input);
    if (input.kind === "request" && input.in_reply_to !== undefined) throw new Error("request cannot carry in_reply_to");
    if (input.kind === "note" && (input.in_reply_to !== undefined || input.response_policy !== undefined)) throw new Error("note cannot carry response correlation or policy");
    if (input.kind === "response" && input.response_policy !== undefined) throw new Error("response cannot carry response_policy");

    const existing = this.findExisting(input);
    if (existing !== undefined) {
      const channel = this.channels.get(existing.channelId);
      if (channel === undefined) throw new Error("idempotent channel message channel is missing");
      return {
        ok: true,
        message: cloneMessage(existing.message),
        channel: cloneChannel(channel),
        ...(this.satisfactionFor(channel, existing.message) === undefined ? {} : { satisfaction: this.satisfactionFor(channel, existing.message) }),
        duplicate: true,
      };
    }

    let channel: StoredChannel;
    let recipients: string[];
    let request: ChannelRequestState | undefined;
    if (input.kind === "response") {
      if (input.in_reply_to === undefined || input.channel_id === undefined) throw new Error("response requires channel_id and in_reply_to");
      const requestLocation = this.findRequestLocation(input.in_reply_to, input.channel_id);
      if (requestLocation === undefined) throw new Error("response refers to an unknown request");
      channel = requestLocation.channel;
      request = requestLocation.request;
      recipients = [request.origin_instance_id];
      if (!channel.participants.includes(input.origin.instance_id)) throw new Error("response origin is not a channel participant");
      if (input.to !== undefined && !sameSet(input.to, recipients)) throw new Error("response destination must be the original requester");
      if (input.channel_id !== undefined && input.channel_id !== channel.channel_id) throw new Error("response channel_id does not match request");
    } else {
      if (input.to === undefined || input.to.length === 0) throw new Error(`${input.kind} requires at least one recipient`);
      recipients = normalizeParticipants(input.to);
      if (recipients.includes(input.origin.instance_id) && input.kind === "request") throw new Error("request recipients must not include the sender");
      const participants = normalizeParticipants([...new Set([input.origin.instance_id, ...recipients])]);
      const existingChannel = this.channelFor(input.channel_id, participants);
      if (existingChannel === undefined) {
        if (input.channel_id !== undefined) throw new Error("channel_id does not match the exact participant set");
        channel = this.createChannel(participants);
      } else {
        channel = existingChannel;
      }
    }

    if (input.kind === "request") {
      const expectation = resolveResponseExpectation(recipients, input.response_policy);
      if (expectation.response_requested_from.includes(input.origin.instance_id)) throw new Error("request sender cannot be a response recipient");
      const message = createChannelMessage({
        channel_id: channel.channel_id,
        message_id: input.message_id,
        sequence: channel.next_sequence,
        kind: input.kind,
        origin: input.origin,
        participants: channel.participants,
        body: input.body,
        response_requested_from: expectation.response_requested_from,
        response_policy: expectation.response_policy,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        ...(input.schema === undefined ? {} : { schema: input.schema }),
        now: this.now,
      });
      request = {
        protocol_version: CHANNEL_PROTOCOL_VERSION,
        channel_id: channel.channel_id,
        request_message_id: message.message_id,
        origin_instance_id: input.origin.instance_id,
        response_requested_from: [...expectation.response_requested_from],
        response_policy: expectation.response_policy,
        responders_received: [],
        state: "open",
      };
      this.ensureRequestCapacity(channel);
      this.registerChannel(channel);
      channel.requests.push(request);
      this.accept(channel, message, input.idempotency_key);
      await this.persist();
      return { ok: true, message: cloneMessage(message), channel: cloneChannel(channel), satisfaction: satisfaction(request), duplicate: false };
    }

    const message = createChannelMessage({
      channel_id: channel.channel_id,
      message_id: input.message_id,
      sequence: channel.next_sequence,
      kind: input.kind,
      origin: input.origin,
      participants: channel.participants,
      body: input.body,
      ...(input.in_reply_to === undefined ? {} : { in_reply_to: input.in_reply_to }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.schema === undefined ? {} : { schema: input.schema }),
      now: this.now,
    });
    if (request !== undefined) {
      const counted = request.response_requested_from.includes(input.origin.instance_id);
      if (counted && !request.responders_received.includes(input.origin.instance_id)) request.responders_received.push(input.origin.instance_id);
      request.responders_received.sort((left, right) => left.localeCompare(right));
      if (request.response_policy === "any" ? request.responders_received.length > 0 : request.response_requested_from.every((id) => request.responders_received.includes(id))) request.state = "satisfied";
    }
    this.registerChannel(channel);
    this.accept(channel, message, input.idempotency_key);
    await this.persist();
    return {
      ok: true,
      message: cloneMessage(message),
      channel: cloneChannel(channel),
      ...(request === undefined ? {} : { satisfaction: satisfaction(request) }),
      duplicate: false,
    };
  }

  private ensureRequestCapacity(channel: StoredChannel): void {
    while (channel.requests.length >= this.maxRequests) {
      const index = channel.requests.findIndex((candidate) => candidate.state === "satisfied");
      if (index < 0) throw new Error("channel request capacity is exhausted");
      this.forgetRequest(channel, index);
    }
  }

  private forgetRequest(channel: StoredChannel, index: number): void {
    const removed = channel.requests.splice(index, 1)[0];
    if (removed === undefined || channel.messages.some((message) => message.message_id === removed.request_message_id)) return;
    this.messageIds.delete(removed.request_message_id);
    for (let entryIndex = channel.idempotency_keys.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = channel.idempotency_keys[entryIndex];
      if (entry?.message_id !== removed.request_message_id) continue;
      channel.idempotency_keys.splice(entryIndex, 1);
      this.idempotency.delete(entry.key);
    }
  }

  private accept(channel: StoredChannel, message: ChannelMessage, idempotencyKey: string | undefined): void {
    channel.messages.push(message);
    channel.next_sequence += 1;
    channel.updated_at = message.sent_at;
    this.messageIds.set(message.message_id, { channelId: channel.channel_id, message });
    if (idempotencyKey !== undefined) {
      channel.idempotency_keys.push({ key: idempotencyKey, message_id: message.message_id });
      this.idempotency.set(idempotencyKey, message.message_id);
    }
    while (channel.messages.length > this.maxMessages) {
      const removed = channel.messages.shift();
      if (removed !== undefined) {
        this.messageIds.delete(removed.message_id);
        const idempotencyIndex = channel.idempotency_keys.findIndex((entry) => entry.message_id === removed.message_id);
        if (idempotencyIndex >= 0) {
          const [idempotencyEntry] = channel.idempotency_keys.splice(idempotencyIndex, 1);
          if (idempotencyEntry !== undefined) this.idempotency.delete(idempotencyEntry.key);
        }
      }
    }
    while (channel.idempotency_keys.length > this.maxMessages) {
      const removed = channel.idempotency_keys.shift();
      if (removed !== undefined) this.idempotency.delete(removed.key);
    }
    while (channel.requests.length > this.maxRequests) {
      const index = channel.requests.findIndex((candidate) => candidate.state === "satisfied");
      if (index < 0) break;
      this.forgetRequest(channel, index);
    }
  }

  private createChannel(participants: string[]): StoredChannel {
    const timestamp = this.now().toISOString();
    const channel: StoredChannel = {
      protocol_version: CHANNEL_PROTOCOL_VERSION,
      channel_id: requireUlid(),
      participants: [...participants],
      next_sequence: 1,
      created_at: timestamp,
      updated_at: timestamp,
      open: true,
      messages: [],
      requests: [],
      idempotency_keys: [],
    };
    return channel;
  }

  private registerChannel(channel: StoredChannel): void {
    if (this.channels.has(channel.channel_id)) return;
    this.channels.set(channel.channel_id, channel);
    this.byParticipants.set(participantKey(channel.participants), channel.channel_id);
  }

  private channelFor(channelId: string | undefined, participants: readonly string[]): StoredChannel | undefined {
    if (channelId !== undefined) {
      const channel = this.channels.get(channelId);
      if (channel === undefined || !sameSet(channel.participants, participants) || !channel.open) return undefined;
      return channel;
    }
    const existingId = this.byParticipants.get(participantKey(participants));
    return existingId === undefined ? undefined : this.channels.get(existingId);
  }

  private findExisting(input: ChannelPostInput): { channelId: string; message: ChannelMessage } | undefined {
    if (input.idempotency_key !== undefined) {
      const messageId = this.idempotency.get(input.idempotency_key);
      if (messageId !== undefined) {
        const existing = this.messageIds.get(messageId);
        if (existing !== undefined) return existing;
      }
    }
    if (input.message_id !== undefined) return this.messageIds.get(input.message_id);
    return undefined;
  }

  private findRequestLocation(requestMessageId: string, channelId: string | undefined): { channel: StoredChannel; request: ChannelRequestState } | undefined {
    if (channelId !== undefined) {
      const channel = this.channels.get(channelId);
      const request = channel?.requests.find((candidate) => candidate.request_message_id === requestMessageId);
      return channel === undefined || request === undefined ? undefined : { channel, request };
    }
    for (const channel of this.channels.values()) {
      const request = channel.requests.find((candidate) => candidate.request_message_id === requestMessageId);
      if (request !== undefined) return { channel, request };
    }
    return undefined;
  }

  private satisfactionFor(channel: StoredChannel, message: ChannelMessage): ChannelSatisfaction | undefined {
    if (message.kind === "request") {
      const request = channel.requests.find((candidate) => candidate.request_message_id === message.message_id);
      return request === undefined ? undefined : satisfaction(request);
    }
    if (message.kind === "response" && message.in_reply_to !== undefined) {
      const request = channel.requests.find((candidate) => candidate.request_message_id === message.in_reply_to);
      return request === undefined ? undefined : satisfaction(request);
    }
    return undefined;
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { protocol_version: CHANNEL_PROTOCOL_VERSION, channels: [...this.channels.values()] };
    await atomicWriteJson(this.options.path, state, 0o600);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}

function satisfaction(request: ChannelRequestState): ChannelSatisfaction {
  return {
    channel_id: request.channel_id,
    request_message_id: request.request_message_id,
    response_requested_from: [...request.response_requested_from],
    response_policy: request.response_policy,
    responders_received: [...request.responders_received],
    state: request.state,
  };
}

function participantKey(participants: readonly string[]): string {
  return JSON.stringify(normalizeParticipants(participants));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  try {
    const a = normalizeParticipants(left);
    const b = normalizeParticipants(right);
    return a.length === b.length && a.every((participant, index) => participant === b[index]);
  } catch {
    return false;
  }
}

function cloneMessage(message: ChannelMessage): ChannelMessage {
  return {
    ...message,
    origin: { ...message.origin },
    participants: [...message.participants],
    ...(message.response_requested_from === undefined ? {} : { response_requested_from: [...message.response_requested_from] }),
    ...(message.usage === undefined ? {} : { usage: { ...message.usage } }),
  };
}

function cloneChannel(channel: StoredChannel): StoredChannel {
  return {
    ...channel,
    participants: [...channel.participants],
    messages: channel.messages.map(cloneMessage),
    requests: channel.requests.map((request) => ({ ...request, response_requested_from: [...request.response_requested_from], responders_received: [...request.responders_received] })),
    idempotency_keys: channel.idempotency_keys.map((entry) => ({ ...entry })),
  };
}

function validatePostInput(input: ChannelPostInput): void {
  if (!isChannelMessageKind(input.kind)) throw new Error("channel message kind is invalid");
  if (typeof input.body !== "string" || input.body.length === 0) throw new Error("channel message body must be non-empty");
  if (!isOriginValue(input.origin)) throw new Error("channel message origin is invalid");
  if (input.channel_id !== undefined && !isUlid(input.channel_id)) throw new Error("channel_id must be a ULID");
  if (input.message_id !== undefined && !isUlid(input.message_id)) throw new Error("message_id must be a ULID");
  if (input.in_reply_to !== undefined && !isUlid(input.in_reply_to)) throw new Error("in_reply_to must be a ULID");
  if (input.response_policy !== undefined && !isResponsePolicy(input.response_policy)) throw new Error("response_policy must be any or all");
  if (input.schema !== undefined && (typeof input.schema !== "string" || input.schema.length === 0)) throw new Error("schema must be a non-empty string");
  if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== "string" || input.idempotency_key.length === 0)) throw new Error("idempotency_key must be a non-empty string");
  if (input.usage !== undefined && (!isRecord(input.usage) || !Number.isSafeInteger(input.usage.input_tokens) || input.usage.input_tokens < 0 || !Number.isSafeInteger(input.usage.output_tokens) || input.usage.output_tokens < 0)) throw new Error("usage is invalid");
}

function isOriginValue(value: unknown): value is A2AOrigin {
  if (!isRecord(value) || typeof value.instance_id !== "string" || value.instance_id.length === 0 || typeof value.name !== "string" || value.name.length === 0 || typeof value.host !== "string" || value.host.length === 0) return false;
  return value.project === undefined || typeof value.project === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedIsLegacyState(value: unknown): value is { protocol_version: number; channels: unknown[] } {
  return isRecord(value) && value.protocol_version === LEGACY_CHANNEL_PROTOCOL_VERSION && Array.isArray(value.channels);
}

function migratePersistedState(value: unknown, maxMessages: number, maxRequests: number): PersistedState | undefined {
  if (!parsedIsLegacyState(value)) return undefined;
  const channels: Record<string, unknown>[] = [];
  for (const candidate of value.channels) {
    if (!isRecord(candidate) || !Array.isArray(candidate.messages) || !Array.isArray(candidate.requests) || !Array.isArray(candidate.idempotency_keys)) return undefined;
    if (candidate.messages.length > maxMessages || candidate.requests.length > maxRequests || candidate.idempotency_keys.length > maxMessages) return undefined;
    if (candidate.messages.some((message) => isRecord(message) && message.kind === "notification")) return undefined;
    channels.push({
      ...candidate,
      protocol_version: CHANNEL_PROTOCOL_VERSION,
      messages: candidate.messages.map((message) => isRecord(message) ? { ...message, protocol_version: CHANNEL_PROTOCOL_VERSION } : message),
      requests: candidate.requests.map((request) => isRecord(request) ? { ...request, protocol_version: CHANNEL_PROTOCOL_VERSION } : request),
    });
  }
  const migrated: unknown = { protocol_version: CHANNEL_PROTOCOL_VERSION, channels };
  return isPersistedState(migrated, maxMessages, maxRequests) ? migrated : undefined;
}

function isPersistedState(value: unknown, maxMessages?: number, maxRequests?: number): value is PersistedState {
  if (!isRecord(value) || value.protocol_version !== CHANNEL_PROTOCOL_VERSION || !Array.isArray(value.channels)) return false;
  const channelIds = new Set<string>();
  const messageIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const candidate of value.channels) {
    if (!isRecord(candidate) || candidate.protocol_version !== CHANNEL_PROTOCOL_VERSION || !isUlid(candidate.channel_id) || !Array.isArray(candidate.participants) || !candidate.participants.every((id) => typeof id === "string" && id.length > 0) || !Number.isSafeInteger(candidate.next_sequence) || (candidate.next_sequence as number) < 1 || typeof candidate.created_at !== "string" || Number.isNaN(Date.parse(candidate.created_at)) || typeof candidate.updated_at !== "string" || Number.isNaN(Date.parse(candidate.updated_at)) || candidate.open !== true || !Array.isArray(candidate.messages) || (maxMessages !== undefined && candidate.messages.length > maxMessages) || !Array.isArray(candidate.requests) || (maxRequests !== undefined && candidate.requests.length > maxRequests) || !Array.isArray(candidate.idempotency_keys) || (maxMessages !== undefined && candidate.idempotency_keys.length > maxMessages)) return false;
    let normalizedParticipants: string[];
    try {
      normalizedParticipants = normalizeParticipants(candidate.participants as string[]);
    } catch {
      return false;
    }
    if (channelIds.has(candidate.channel_id) || JSON.stringify(candidate.participants) !== JSON.stringify(normalizedParticipants)) return false;
    channelIds.add(candidate.channel_id);
    const channel = candidate as unknown as StoredChannel;
    let previousSequence = 0;
    for (const rawMessage of channel.messages) {
      const parsed = parseChannelMessage(rawMessage);
      if (!parsed.ok) return false;
      const message = parsed.value;
      if (message.channel_id !== channel.channel_id || !sameSet(message.participants, channel.participants) || message.sequence <= previousSequence || message.sequence >= channel.next_sequence || messageIds.has(message.message_id)) return false;
      previousSequence = message.sequence;
      messageIds.add(message.message_id);
    }
    for (const rawRequest of channel.requests) {
      const parsed = parseChannelRequestState(rawRequest);
      if (!parsed.ok) return false;
      const request = parsed.value;
      if (requestIds.has(request.request_message_id)) return false;
      requestIds.add(request.request_message_id);
      const requestMessage = channel.messages.find((message) => message.message_id === request.request_message_id);
      if (request.channel_id !== channel.channel_id || !channel.participants.includes(request.origin_instance_id) || request.response_requested_from.some((id) => !channel.participants.includes(id))) return false;
      if (requestMessage !== undefined && (requestMessage.kind !== "request" || requestMessage.origin.instance_id !== request.origin_instance_id || requestMessage.response_policy !== request.response_policy || !sameSet(requestMessage.response_requested_from ?? [], request.response_requested_from))) return false;
    }
    const idempotencyKeys = new Set<string>();
    for (const entry of channel.idempotency_keys) {
      if (!isRecord(entry) || typeof entry.key !== "string" || entry.key.length === 0 || typeof entry.message_id !== "string" || idempotencyKeys.has(entry.key) || !channel.messages.some((message) => message.message_id === entry.message_id)) return false;
      idempotencyKeys.add(entry.key);
    }
  }
  return true;
}

function requireUlid(): string {
  // Kept in one place so the aggregate never accepts a caller-supplied channel
  // identity when it creates a new participant set.
  return ulid();
}
