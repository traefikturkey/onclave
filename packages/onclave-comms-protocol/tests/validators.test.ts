import { describe, expect, it } from 'vitest';
import {
  validateCapabilityDeclaration,
  validateCommandEnvelope,
  validateRegistration,
} from '../src/validators.js';

describe('protocol validators', () => {
  it('accepts a valid agent registration', () => {
    const result = validateRegistration({
      protocolVersion: '1.0',
      agentId: 'agent-hermes',
      runtimeInstanceId: 'runtime-1',
      sessionId: 'session-1',
      runtime: { type: 'hermes', version: '1.0.0' },
      capabilities: ['message.receive'],
      declaredAt: '2026-07-17T12:00:00.000Z',
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects a registration with an invalid identity', () => {
    const result = validateRegistration({
      protocolVersion: '1.0',
      agentId: '',
      runtimeInstanceId: 'runtime-1',
      sessionId: 'session-1',
      runtime: { type: 'hermes', version: '1.0.0' },
      capabilities: [],
      declaredAt: '2026-07-17T12:00:00.000Z',
    });

    expect(result).toMatchObject({ valid: false, error: 'agentId must be a non-empty string' });
  });

  it('rejects a capability response bound to the wrong nonce', () => {
    const result = validateCapabilityDeclaration({
      protocolVersion: '1.0',
      requestId: 'request-1',
      nonce: 'wrong-nonce',
      agentId: 'agent-1',
      capabilities: ['message.receive'],
      declaredAt: '2026-07-17T12:00:00.000Z',
      expectedNonce: 'expected-nonce',
    });

    expect(result).toMatchObject({ valid: false, error: 'capability nonce does not match request' });
  });

  it('accepts a command with a correlation and expiration timestamp', () => {
    const result = validateCommandEnvelope({
      protocolVersion: '1.0',
      messageId: 'message-1',
      correlationId: 'correlation-1',
      commandType: 'task.assign',
      sourceAgentId: 'agent-source',
      targetAgentId: 'agent-target',
      issuedAt: '2026-07-17T12:00:00.000Z',
      expiresAt: '2026-07-17T12:05:00.000Z',
      payload: { taskId: 'task-1' },
    });

    expect(result).toEqual({ valid: true });
  });
});
