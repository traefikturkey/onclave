---
created: 2026-07-18
status: active
source_prd: ./PRD.md
branch: feature/v2-broker-core
---

# Status: Onclave A2A-Derived Message and Task Boundary

## Current state

The current Onclave worktree contains the shared A2A-derived message and task
contract, the core task store and status-event routing, and the reduced Pi
adapter surface. This status file records the aligned contract; it does not
claim a live deployment or a broker cutover.

## Delivered contract

- Messages use explicit protocol version 1, `message_id`, `context_id`, an
  optional `task_id`, origin, destination, body, timestamps, hop and trace
  metadata, and optional usage.
- Supported types are `ask`, `request`, and `inform`.
- `ask` waits once for a direct response or interrupted or terminal task result,
  bounded by `timeout_ms`; timeout does not cancel a created task.
- `request` publishes asynchronously and returns message and context
  identifiers. The receiver creates the task and emits `submitted`.
- `inform` is point-to-point or broadcast, creates no task, expects no response,
  and never triggers a turn.
- Task states are `submitted`, `working`, `input-required`, `completed`,
  `failed`, `canceled`, and `rejected`.
- Terminal tasks are immutable. An `input-required` task can continue with the
  same task and context. Terminal refinement creates a new task in the same
  context and may reference the prior task.
- Status events are durably routed to the originating instance. The adapter
  triggers a caller turn only for `input-required` and terminal outcomes;
  intermediate status is display-only.

## Adapter surface

Only two model-facing tools are registered:

| Tool | Behavior |
| --- | --- |
| `onclave_instances` | Lists live registered independent Pi instances and evidence-backed status. |
| `onclave_message` | Sends `ask`, `request`, or `inform` with deterministic conditional validation. |

The adapter does not register Pi-local subagents as instances. MCP integration
is not delivered. The A2A-derived semantics apply only to communication between
independent Onclave instances.

Outbound discovery and messaging are operator-directed. Runtime tool guidance
permits explicit operator requests and continuation of an already
operator-directed Onclave workflow. It prohibits using Onclave for Pi-local
subagents, reviewers, failed delegation, provider fallback, local execution, or
autonomous workload distribution.

## Acceptance and authority

RabbitMQ acknowledgement, core publication, signed HTTPS `202`, and adapter
delivery disposition are transport handling. `submitted` is application-level
acceptance for task tracking. A transport result does not mean that a peer has
accepted or completed work.

Instance authentication binds identity and signing key, not operator authority.
Peer message bodies remain untrusted input. Cross-host turn-triggering messages
require operator confirmation unless an explicit host policy accepts them.
`inform` remains inert even when its body is imperative.

## Protocol break and future seam

The protocol version is explicit and incompatible versions fail explicitly. The
retired six-tool communication model is not an active interface, and the core
and adapters must be upgraded across this boundary together. No live deployment
or broker cutover is represented here.

Authenticated webhook ingress is a future evolution seam only. A later
server-side policy layer may classify an authenticated, idempotent external
event as `inform` or `request` for a Pi adapter or a future Hermes consumer.
There is no webhook endpoint, ingress authentication workflow, MCP face, or
Hermes adapter delivered in this worktree.

## Validation state

The executable implementation and tests are outside this documentation-only
change. Required repository gates remain:

```bash
just check
just test-integration
git diff --check
```

Direct documentation inspection must confirm the two-tool surface, the three
message types, all task states and transition rules, transport versus
application acceptance, the authority boundary, operator-directed outbound use,
the prohibition on Pi-local delegation substitution, the protocol break, and
the undelivered webhook and Hermes seam. Any failure in those gates or any
mismatch with executable behavior is a remaining release gap, not a
documentation claim.
