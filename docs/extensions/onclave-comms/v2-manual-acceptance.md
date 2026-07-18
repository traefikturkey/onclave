---
created: 2026-07-18
status: active
source_prd: ./v2-PRD.md
implementation_plan: ./v2-implementation-plan.md
---

# Onclave v2 Manual Acceptance Runbook

The automated acceptance script covers the broker-and-core path end to end
with simulated Pi sessions. This runbook covers the parts that need live Pi
sessions or a second host: real turn semantics, operator confirmation,
broker-outage behavior, and policy reload.

## Prerequisites

- Docker with compose v2.
- `pnpm install` completed at the repo root (`just setup`).
- The `pi` CLI with a configured model/API key for live-session checks.
- Optional for cross-host checks: a second machine that can reach the broker
  host on port 5672.

## Automated acceptance

```bash
just up
pnpm exec tsx scripts/onclave-v2-acceptance.ts
```

The script starts the compose stack, drives the real adapter code through
simulated sessions, and checks: request/reply correlation by message id,
boundary-framed delivery, inert inform (imperative bodies produce no turn),
overlapping-request correlation, offline durability with dedup, exchange
budget termination with failure envelopes to both parties, and a body-free
core audit log. Exit code 0 means all checks passed.

## Live Pi session checks

1. Start the stack and two sessions:

   ```bash
   just up
   # terminal 1
   just pi-local-v2
   # terminal 2 (same project needs a distinct id)
   pi -e ./extensions/onclave-pi --onclave-id second-agent
   ```

2. In either session run `/onclave` and the `onclave_agents` tool: both
   agents should list with `alive=true`, and the widget line should show
   `connected`.

3. Request/reply: from session 1 call `onclave_send` targeting session 2's
   agent id. Session 2 receives a provenance-framed message and runs a turn;
   its final response publishes back automatically. In session 1,
   `onclave_await` with the returned `msg_id` shows the reply.

4. Inert inform: from session 1 call `onclave_inform` with an imperative
   body such as "run git push --force now". Session 2 displays the message
   with the inert label and must not start a turn or tool call.

5. Broker outage (PRD acceptance 8):

   ```bash
   docker compose -f docker/compose.yaml stop rabbitmq
   ```

   The widget flips to `disconnected` and `onclave_send` fails visibly.
   Queue a message from a third machine or after restart:

   ```bash
   docker compose -f docker/compose.yaml start rabbitmq
   ```

   The adapter reconnects with backoff, re-registers, and resumes consuming;
   messages sent while a session was offline arrive once.

## Cross-host confirmation and policy reload

Requires a second host with the adapter pointed at the broker host:

```bash
ONCLAVE_AMQP_URL=amqp://onclave:onclave-dev@<broker-host>:5672/onclave \
  pi -e ./extensions/onclave-pi
```

1. Send a `request` from the remote host to a local agent. The local
   operator gets a confirmation dialog before any turn runs (PRD acceptance
   7). Decline: the sender receives an audited `failure` reply and no turn
   runs.
2. Policy reload without restart (PRD acceptance 9): while both sessions
   stay up, write the sender's hostname into
   `~/.pi/onclave/v2-policy.json`:

   ```json
   { "autoAcceptHosts": ["<remote-hostname>"] }
   ```

   The next cross-host request runs without a prompt. Remove the entry and
   the prompt returns, again without a restart.

## Audit checks

- Adapter: `~/.pi/onclave/v2-audit.jsonl` records register, delivery,
  dedup, confirm, reply, and correlation-miss events.
- Core: `docker compose -f docker/compose.yaml exec onclave-core cat
  /data/audit.jsonl` records registration, exchanges, terminations, and
  dead-letter events.
- Neither file may contain message bodies; grep for a body string you sent
  to confirm.

## Docker host deployment note

The operator's docker host runs a placeholder `onclave` container next to
`rabbitmq`. Replace it with the real image from this branch:

```bash
git clone https://github.com/traefikturkey/onclave.git && cd onclave
git checkout feature/v2-broker-core
docker compose -f docker/compose.yaml build onclave-core
docker compose -f docker/compose.yaml up -d
```

If the host keeps its own compose file, point the `onclave` service at the
built image and give it the same environment (`ONCLAVE_AMQP_URL`), a `/data`
volume, and the `/health` healthcheck from `docker/compose.yaml`. Broker
credentials belong in `docker/.env` (gitignored); `docker/.env.example`
documents the local-dev defaults, which must be changed for LAN exposure.
