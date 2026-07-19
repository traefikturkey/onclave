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
   `~/.pi/agent/onclave/v2-policy.json`:

   ```json
   { "autoAcceptHosts": ["<remote-hostname>"] }
   ```

   The next cross-host request runs without a prompt. Remove the entry and
   the prompt returns, again without a restart.

## Cross-machine operator delegation

On the receiving machine, add the sender agent id to the restart-free policy:

```json
{
  "autoAcceptHosts": [],
  "delegatedAuthorityAgents": ["<sender-agent-id>"]
}
```

1. Ask the sending session to delegate a bounded workflow. It should call
   `onclave_delegate` with the target agent, exact request, concise scope,
   action classes, and a short lifetime.
2. Review or edit the complete request in the operator editor, inspect the
   target/actions/scope/expiry summary, and confirm once.
3. The receiver must display `verified operator delegation`, the grant id,
   actions, expiry, and scope, then execute the bounded request without asking
   for the same approval again.
4. Alter the body, audience, project, or expiry. The receiver must reject the
   request and produce no turn.
5. Remove the sender from `delegatedAuthorityAgents` without restarting. The
   next delegated request must be rejected.
6. Send an ordinary `onclave_send` request. It must retain the original
   non-authoritative provenance framing and cross-host confirmation behavior.

Delegation does not replace repository safety rules, reviewed infrastructure
plans, rollback requirements, or separately gated destructive operations.

## Audit checks

- Adapter: `~/.pi/agent/onclave/v2-audit.jsonl` records register, delivery,
  dedup, confirm, reply, and correlation-miss events.
- Core: `docker compose -f docker/compose.yaml exec onclave-core cat
  /data/audit.jsonl` records registration, exchanges, terminations, and
  dead-letter events.
- Neither file may contain message bodies; grep for a body string you sent
  to confirm.

## Docker host deployment

The central stack deploys to the docker host with the ansible harness in
`infra/` (see `infra/README.md`), replacing the placeholder `onclave`
container:

```bash
just deploy-build
just deploy
```

The playbook renders broker credentials from Bitwarden Secrets Manager
(machine account token from the host shell; see `infra/README.md`), syncs
the build context to `/srv/onclave/src`, builds the core image on the
host, starts the stack, and verifies `/health` reports broker
connectivity. Local development keeps using `docker/compose.yaml` with the
`docker/.env.example` defaults.
