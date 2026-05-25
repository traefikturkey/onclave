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

From this repository, the happy developer path is:

```bash
just setup
just check
just pi-local
```

- `just setup` installs dependencies with pnpm.
- `just check` runs typecheck and tests.
- `just pi-local` starts Pi with `./extensions/pi-onclave` loaded.

For a named local session, run Pi directly:

```bash
pi -e ./extensions/pi-onclave --name host-a
```

## Install the Pi Extension

Use one of these install/load paths depending on what you are trying to do.

### Local development load

Use this while working in this repo:

```bash
just setup
just pi-local
```

Equivalent direct Pi command:

```bash
pi -e ./extensions/pi-onclave
```

### Local package install

Use this to test package metadata from a local checkout:

```bash
pi install .
```

### Git package install

Use this to install from a Git remote:

```bash
pi install git:git@github.com:traefikturkey/onclave.git
```

After installing from a local path or Git URL, start Pi normally and run:

```text
onclave_status
```

Loading `extensions/pi-onclave` directly is supported when the directory remains
inside this repo checkout; it is not a standalone copied package yet.

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

1. Start Pi with `extensions/pi-onclave` loaded from inside this repo checkout.
2. Run `onclave_status` to initialize or reuse the local hub.
3. Exchange `ssh-ed25519` public key lines with trusted peers.
4. Use `onclave_peers` and `onclave_remote_agents` to find reachable remote
   sessions.
5. Use `onclave_send` or `onclave_remote_send` to route prompts.

For the full tool reference and examples, start with
[docs/USAGE.md](./docs/USAGE.md).
