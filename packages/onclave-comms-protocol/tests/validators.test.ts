import { describe, expect, it } from 'vitest';
import {
  validateCapabilityDeclaration,
  validateCommandEnvelope,
  validateEventEnvelope,
  validateRegistration,
  validateSubscription,
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

  it('accepts a lifecycle event envelope', () => {
    expect(validateEventEnvelope({
      protocolVersion: '1.0',
      messageId: 'event-1',
      eventType: 'task.completed',
      taskId: 'task-1',
      sourceAgentId: 'agent-source',
      targetAgentId: 'agent-target',
      occurredAt: '2026-07-17T12:00:00.000Z',
      payload: { passed: true },
    })).toEqual({ valid: true });
  });

  it('rejects an event with an unsupported lifecycle type', () => {
    expect(validateEventEnvelope({
      protocolVersion: '1.0', messageId: 'event-1', eventType: 'agent.status', taskId: 'task-1',
      sourceAgentId: 'agent-source', occurredAt: '2026-07-17T12:00:00.000Z', payload: {},
    })).toMatchObject({ valid: false, error: 'unsupported event type' });
  });

  it('accepts an agent-scoped subscription with a cursor', () => {
    expect(validateSubscription({
      protocolVersion: '1.0', subscriptionId: 'subscription-1', agentId: 'agent-target',
      pattern: 'task.completed.agent-target', createdAt: '2026-07-17T12:00:00.000Z',
      expiresAt: '2026-07-17T13:00:00.000Z', cursor: 4, filters: { correlationId: 'workflow-1' },
    })).toEqual({ valid: true });
  });

  it('rejects a subscription that targets another agent namespace', () => {
    expect(validateSubscription({
      protocolVersion: '1.0', subscriptionId: 'subscription-1', agentId: 'agent-target',
      pattern: 'task.completed.agent-other', createdAt: '2026-07-17T12:00:00.000Z',
      expiresAt: '2026-07-17T13:00:00.000Z',
    })).toMatchObject({ valid: false, error: 'pattern must target the subscribing agent task event namespace' });
  });
});
