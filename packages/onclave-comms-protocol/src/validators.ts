export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const protocolVersion = (value: unknown): value is string => value === '1.0';

export function validateRegistration(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') return { valid: false, error: 'registration must be an object' };
  const registration = value as Record<string, unknown>;
  if (!protocolVersion(registration.protocolVersion)) return { valid: false, error: 'unsupported protocol version' };
  if (!nonEmpty(registration.agentId)) return { valid: false, error: 'agentId must be a non-empty string' };
  if (!nonEmpty(registration.runtimeInstanceId)) return { valid: false, error: 'runtimeInstanceId must be a non-empty string' };
  if (!nonEmpty(registration.sessionId)) return { valid: false, error: 'sessionId must be a non-empty string' };
  if (!isoTimestamp(registration.declaredAt)) return { valid: false, error: 'declaredAt must be an ISO timestamp' };
  if (!registration.runtime || typeof registration.runtime !== 'object') return { valid: false, error: 'runtime is required' };
  const runtime = registration.runtime as Record<string, unknown>;
  if (!nonEmpty(runtime.type) || !nonEmpty(runtime.version)) return { valid: false, error: 'runtime type and version are required' };
  if (!Array.isArray(registration.capabilities) || registration.capabilities.some((capability) => !nonEmpty(capability))) {
    return { valid: false, error: 'capabilities must be an array of non-empty strings' };
  }
  return { valid: true };
}

export function validateCapabilityDeclaration(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') return { valid: false, error: 'capability declaration must be an object' };
  const declaration = value as Record<string, unknown>;
  if (!protocolVersion(declaration.protocolVersion)) return { valid: false, error: 'unsupported protocol version' };
  if (!nonEmpty(declaration.requestId) || !nonEmpty(declaration.nonce)) return { valid: false, error: 'requestId and nonce are required' };
  if (!nonEmpty(declaration.agentId)) return { valid: false, error: 'agentId must be a non-empty string' };
  if (declaration.expectedNonce !== undefined && declaration.nonce !== declaration.expectedNonce) {
    return { valid: false, error: 'capability nonce does not match request' };
  }
  if (!Array.isArray(declaration.capabilities) || declaration.capabilities.some((capability) => !nonEmpty(capability))) {
    return { valid: false, error: 'capabilities must be an array of non-empty strings' };
  }
  if (!isoTimestamp(declaration.declaredAt)) return { valid: false, error: 'declaredAt must be an ISO timestamp' };
  return { valid: true };
}

export function validateCommandEnvelope(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') return { valid: false, error: 'command must be an object' };
  const command = value as Record<string, unknown>;
  if (!protocolVersion(command.protocolVersion)) return { valid: false, error: 'unsupported protocol version' };
  for (const field of ['messageId', 'correlationId', 'commandType', 'sourceAgentId', 'targetAgentId']) {
    if (!nonEmpty(command[field])) return { valid: false, error: `${field} must be a non-empty string` };
  }
  if (!isoTimestamp(command.issuedAt) || !isoTimestamp(command.expiresAt)) {
    return { valid: false, error: 'issuedAt and expiresAt must be ISO timestamps' };
  }
  if (Date.parse(command.expiresAt as string) <= Date.parse(command.issuedAt as string)) {
    return { valid: false, error: 'expiresAt must be after issuedAt' };
  }
  if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
    return { valid: false, error: 'payload must be an object' };
  }
  return { valid: true };
}

const taskEventTypes = new Set([
  'task.accepted', 'task.acknowledged', 'task.started', 'task.progress',
  'task.completed', 'task.failed', 'task.cancelled', 'task.expired',
]);

export function validateEventEnvelope(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') return { valid: false, error: 'event must be an object' };
  const event = value as Record<string, unknown>;
  if (!protocolVersion(event.protocolVersion)) return { valid: false, error: 'unsupported protocol version' };
  for (const field of ['messageId', 'taskId', 'sourceAgentId']) {
    if (!nonEmpty(event[field])) return { valid: false, error: `${field} must be a non-empty string` };
  }
  if (event.targetAgentId !== undefined && !nonEmpty(event.targetAgentId)) {
    return { valid: false, error: 'targetAgentId must be a non-empty string when provided' };
  }
  if (!taskEventTypes.has(event.eventType as string)) return { valid: false, error: 'unsupported event type' };
  if (!isoTimestamp(event.occurredAt)) return { valid: false, error: 'occurredAt must be an ISO timestamp' };
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return { valid: false, error: 'payload must be an object' };
  }
  return { valid: true };
}

export function validateSubscription(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') return { valid: false, error: 'subscription must be an object' };
  const subscription = value as Record<string, unknown>;
  if (!protocolVersion(subscription.protocolVersion)) return { valid: false, error: 'unsupported protocol version' };
  for (const field of ['subscriptionId', 'agentId', 'pattern']) {
    if (!nonEmpty(subscription[field])) return { valid: false, error: `${field} must be a non-empty string` };
  }
  const patternParts = (subscription.pattern as string).split('.');
  const eventName = patternParts[1];
  const validEventName = eventName === '*' || Array.from(taskEventTypes).some((type) => type.split('.')[1] === eventName);
  if (patternParts.length !== 3 || patternParts[0] !== 'task' || !validEventName || patternParts[2] !== subscription.agentId) {
    return { valid: false, error: 'pattern must target the subscribing agent task event namespace' };
  }
  if (!isoTimestamp(subscription.createdAt) || !isoTimestamp(subscription.expiresAt)) {
    return { valid: false, error: 'createdAt and expiresAt must be ISO timestamps' };
  }
  if (Date.parse(subscription.expiresAt as string) <= Date.parse(subscription.createdAt as string)) {
    return { valid: false, error: 'expiresAt must be after createdAt' };
  }
  if (subscription.cursor !== undefined && (!Number.isInteger(subscription.cursor) || (subscription.cursor as number) < 0)) {
    return { valid: false, error: 'cursor must be a non-negative integer' };
  }
  if (subscription.filters !== undefined && (!subscription.filters || typeof subscription.filters !== 'object' || Array.isArray(subscription.filters))) {
    return { valid: false, error: 'filters must be an object' };
  }
  return { valid: true };
}
