# Onclave

`Onclave` is a Pi extension for secure LAN discovery, explicit trust, and
prompt routing between Pi sessions on trusted machines.

> [!NOTE]
> This project expands on IndyDevDan's Pi coding agent extension work for
> two-way communication between agents and takes it further into secure LAN
> discovery, explicit machine trust, and authenticated cross-host messaging.
> Watch his video here:
> [Pi coding agent extension with two-way agent communication](https://www.youtube.com/watch?v=PIdETjcXNIk)

## What It Does

- starts or reuses one local machine hub per host;
- discovers peer hubs on the LAN over UDP broadcast;
- requires explicit Ed25519 trust exchange before remote access is allowed;
- routes prompts and responses over authenticated WSS connections;
- supports static peers when UDP discovery is unavailable;
- shows peer status directly in Pi with a compact widget.

## Quick Start

From this repository:

```bash
pi --no-extensions -e ./extensions/onclave.ts --name host-a
```

Then inside Pi:

```text
onclave_status
onclave_agents
onclave_peers
```

If you want help preparing a host for manual acceptance testing:

```bash
bun run onclave:acceptance-host -- --host-name host-a
```

## Documentation

- [Usage Guide](./docs/USAGE.md) - quick starts, extension loading, flags,
  status dots, and tool examples
- [Operator Guide](./docs/ONCLAVE_OPERATOR_GUIDE.md) - runtime state,
  trust exchange, discovery, messaging, and troubleshooting
- [Manual Acceptance](./docs/ONCLAVE_MANUAL_ACCEPTANCE.md) - step-by-step
  host-to-host validation flow
- [Status](./docs/STATUS.md) - implementation progress and delivered scope
- [Design Decisions](./docs/ONCLAVE_DECISIONS.md) - key v1 design choices
- [Product Requirements](./docs/PRD.md) - original requirements and success
  criteria

## Current Usage Model

1. Start Pi with `extensions/onclave.ts` loaded.
2. Run `onclave_status` to initialize or reuse the local hub.
3. Exchange `ssh-ed25519` public key lines with trusted peers.
4. Use `onclave_peers` and `onclave_remote_agents` to find reachable remote
   sessions.
5. Use `onclave_send` or `onclave_remote_send` to route prompts.

For the full tool reference and examples, start with
[docs/USAGE.md](./docs/USAGE.md).
