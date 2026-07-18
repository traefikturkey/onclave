---
status: active
---

# Onclave Pi Extension Status

## Current scope

The repository's primary product is the containerized gateway under
`services/onclave`. The gateway authenticates and vets runtimes, negotiates
capabilities, persists tasks and events in SQLite, and exposes authenticated
HTTP/WebSocket APIs. RabbitMQ is an internal transport boundary.

`extensions/onclave-pi` is the first-party Pi client for that public gateway.
It is not a separate gateway, broker adapter, LAN hub service, or architectural
boundary for future runtimes.

## Implemented Pi behavior

- Pi extension metadata and `org.onclave.pi` manifest identity;
- gateway challenge-response authentication using the configured Ed25519 key;
- capability negotiation for `message.send` and `message.receive`;
- authenticated WSS session startup and shutdown;
- inbound gateway command injection into Pi;
- task completion reporting from the Pi `agent_end` lifecycle;
- `onclave_send` task submission;
- `onclave_get` task lookup;
- `onclave_await` terminal-state waiting;
- bounded prompt and wait-time inputs;
- gateway error reporting without credential logging;
- product-level state under `~/.pi/onclave/`.

## Current files

- `extensions/onclave-pi/src/onclave-pi.ts` — Pi entrypoint;
- `extensions/onclave-pi/src/lib/gateway-adapter.ts` — public gateway HTTP client;
- `extensions/onclave-pi/src/lib/pi-gateway-session.ts` — authenticated WSS session;
- `extensions/onclave-pi/src/lib/identity.ts` — local Ed25519 identity loading;
- `extensions/onclave-pi/src/lib/state.ts` — product-level state paths;
- `extensions/onclave-pi/tests/` — Vitest coverage for the extension and its
  supporting modules.

## Verification

Run from the repository root:

```bash
pnpm run typecheck
pnpm run test
```

The gateway verification commands are:

```bash
go test ./services/onclave/...
just gateway-acceptance
just gateway-restart-acceptance
just gateway-broker-restart-acceptance
just go-rabbitmq-test
```

The live acceptance commands require the corresponding local Compose and
RabbitMQ environment.

## Documentation authority

For current behavior, use:

- [Pi Extension Guide](./README.md);
- [Pi Operator Guide](./operator-guide.md);
- [Pi Gateway Acceptance](./manual-acceptance.md);
- [Agent Gateway Contract](../../agent-gateway.md);
- [Agent Extension Contract](../../agent-extension-contract.md).

- [Future Product PRD](../../onclave-factory-PRD.md);

The future PRD contains only remaining product scope. Current behavior belongs in
this guide, the gateway contract, the extension contract, and the implementation
itself.
