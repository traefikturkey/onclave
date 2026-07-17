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
