# PRD: Homelab Platform Architecture

Status: draft, 2026-07-26.

Child PRDs:

- [menos service discovery](2026-07-26-menos-service-discovery-PRD.md)

## Purpose

Six repositories have grown into one platform without an agreed set of
boundaries. Each has independently invented a service catalog, a secret model,
and an ingress story, and several now claim overlapping ownership. This document
records the boundaries so future work stops relitigating them.

This is an architecture and ownership PRD. It records decisions. Implementation
belongs in child PRDs, one per slice, each small enough to ship on its own.

## Repository Roles

| Repository | Role |
|---|---|
| `.dotfiles` | Workstation. Shell, links, packages, and the Pi/Claude agent runtime |
| `homelab-infra` | Substrate. Provisions all Proxmox guests, owns OpenTofu state, runs first-class infrastructure services |
| `onramp-vNext` | The service catalog, and app deployment onto hosts the substrate created |
| `onclave` | Alpha incubator for AI tooling and services, plus the agent message bus |
| `onramp` | The original platform. Roughly 280 service definitions, now a migration source |
| `joyride` | DNS. CoreDNS plugin serving Docker-label records, replicated between nodes by gossip |

## Provisioning Ownership

`homelab-infra` owns all Proxmox guest provisioning: LXC and VM creation,
sizing, addressing, and OpenTofu state. `onramp-vNext` targets hosts that
already exist and does not create guests.

This resolves a conflict that runs through several `onramp-vNext` documents,
not just one:

- `onramp-vNext/docs/prd/onramp-vnext-mvp-scope.md:126` lists
  `onramp host provision proxmox` in the public MVP command surface, and
  `:114-116` puts "Proxmox/bare-metal bootstrap" in the Public MVP milestone.
- `onramp-vNext/docs/prd/onramp-vnext-architecture-decisions.md:136,545` states
  that OnRamp owns provisioning for supported providers, beginning with Proxmox.
- `onramp-vNext/docs/prd/onramp-vnext-current-snapshot.md:98` still describes
  Proxmox provisioning as supported.

That scope is dropped across all of them. No `onramp-vNext` CLI command
implements Proxmox provisioning today, so nothing built is being discarded, but
three documents need updating and none have been.

Rationale: two control planes must not both create Proxmox guests, because
OpenTofu holds the state and will not see externally created resources.
Provisioning stays where it already works, with its reviewed plan, stale-plan
detection, backup-age gates, and canary rollout discipline.

The public-product framing throughout the `onramp-vNext` PRDs is aspirational.
The current and near-term user base is one operator experimenting. Design so as
not to foreclose an open-source future, but do not build for it now.

## Catalog Ownership

`onramp-vNext` is the service catalog. Its schema, validation, distribution, and
search behavior are already specified in
`onramp-vNext/docs/prd/onramp-catalog-distribution-prd.md`, which is the
strongest design of the four catalogs and should win.

`onclave` is the alpha incubator. AI services prove themselves there, then
graduate into the vNext catalog as official entries. Incubating services carry
no stability expectation.

The four catalogs are layered, not competing:

| Catalog | Contains | Status |
|---|---|---|
| `homelab-infra/infra/services.json` | Infrastructure services only | Currently polluted with three app services |
| `onramp-vNext` catalog | Official app services | The destination |
| `onclave/infra/services.json` | Incubating AI services | Right shape, stale content (see Cleanup) |
| `onramp/services-available/` | Roughly 280 definitions | Migration source |

Porting is deferred until the catalog schema stabilizes. Porting now
means porting twice, and the operator does not run most of them.

Note that the port is not a label translation. It is extraction of routing
intent from Traefik labels into catalog entries, which is more work per service
but produces the catalog metadata the schema wants anyway.

## Ingress

Caddy is the target. Traefik was chosen originally for its Docker Compose label
model, not for its configuration language.

Routing uses **generated configuration**, not labels, per
`onramp-vNext/docs/prd/onramp-personal-paas-redesign-prd.md:64`. This is a
deliberate trade: label-driven routing makes routes appear as a side effect of a
container starting, which defeats plan/apply. A central route model is required
by the agent-first principle at
`onramp-vNext/docs/prd/onramp-vnext-mvp-scope.md:40-41`, which says plans must
show route changes before they are applied.

Labels remain in use for DNS. joyride reads them today. The split is coherent:
the label says what a container is called, the route model says how it is
exposed.

## Secrets

Bitwarden Secrets Manager is the only secret source in use. Infisical remains a
deployed service but is not a secret source. A provider interface is future
work.

That withdraws a locked convention:
`onramp-vNext/docs/prd/onramp-personal-paas-redesign-prd.md:62` and
`onramp-vnext-mvp-scope.md:69` both name Infisical as the secret source of
truth. Note the withdrawal is not yet reflected in `onramp-vNext`, whose `init`
command is largely an Infisical bootstrap. Reworking `init` is deferred.

Rationale: Infisical cannot hold the bootstrap secrets for the infrastructure it
runs on. It is a service on a host that `homelab-infra` provisions, so the
Proxmox API token needed to create that host cannot live inside it. Something
outside must hold the seed. Bitwarden is SaaS and has no such circularity, and a
working code path exists in `onclave/scripts/onclave-bws-env.py`. Live retrieval
has not been verified from the repository alone.

**Services declare the secret names they require, not where those secrets
live.** Three partial expressions of this already exist:

- `onclave/deploy/app/onclave/env-contract.md`
- the former Menos environment contract
- the `STACKS` dictionary in `onclave/scripts/onclave-bws-env.py`

They did not agree. The former Menos environment contract required
`POSTGRES_PASSWORD`, while `onclave-bws-env.py:32-60` still requires
`SURREALDB_PASSWORD` and carries SurrealDB defaults. Reconciling them against
the actual app definition is a prerequisite, not a free promotion.

The target is a machine-readable field on the catalog entry:

```yaml
secrets:
  required: [RABBITMQ_DEFAULT_USER, RABBITMQ_DEFAULT_PASS]
  generated: [S3_SECRET_KEY]
```

Names here are the app's environment contract, not consumer-side inventory
names. The former app contract used `S3_SECRET_KEY`; `MENOS_S3_SECRET_KEY` is the
name `homelab-infra` uses in its own private inventory. Mixing the two layers in
one field is a mistake worth avoiding from the start.

A separate catalog field should carry image and definition digests. Private
`values/ansible/inventory/local.yml:114-129` currently hand-maintains two
app-definition hashes, eight digest-pinned image references, two helper-script
hashes, and source revision pins. Automating those is desirable but is not free:
`homelab-infra/scripts/update.py:157-161` targets Infisical, SearXNG, and
tooling values today and has no Onclave or Menos path at all, so this is new
implementation rather than a configuration change.

No provider abstraction is built yet. A pluggable secret interface is the
long-term goal, and the read plane (`get`, `set`, `list`, `exists`) abstracts
cleanly while bootstrap and auth do not. But an interface with one
implementation is a speculative platform feature, which
`onramp-vnext-mvp-scope.md:91` explicitly warns against. The declaration above
is the cheap forward-compatible move; build the interface when a second backend
is actually wanted.

## Discovery

Clients resolve services by name through the existing DNS chain, not through a
discovery protocol. Gossip stays where it earns its keep, replicating records
between joyride nodes.

Concretely, a client derives a service URL from a domain plus the deployed
hostname convention (`<service>.<domain>`, HTTPS on 443 behind Caddy). The A
records already exist; nothing new is published.

A DNS SRV record was specified first and then withdrawn on 2026-07-27 after
adversarial review. The A record already existed, every SRV-specific capability
(port flexibility, priority, weight) was unused because the design fixes port
443 with one instance, and the SRV machinery carried most of the defect surface.
SRV becomes correct if a service ever needs a non-default port or multiple
weighted instances; the research supporting it is preserved in the child PRD.

The domain variable is `HOST_DOMAIN`, reusing the convention already in use in
`onramp` and `onramp-vNext` rather than inventing a per-service one.

See [menos service discovery](2026-07-26-menos-service-discovery-PRD.md).

### Credential-bearing connections use the secret plane

The Onclave broker connection uses a non-default port and RabbitMQ credentials.
The operator configuration therefore stores only the non-secret AMQP endpoint
and the Bitwarden Secrets Manager project ID. At startup, the adapter reads
`RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS` from BWS and assembles the
credential-bearing URL in memory.

The local bootstrap boundary is `BITWARDEN_ACCESS_KEY` in the encrypted dotfiles
private store. Deployment controllers receive that key through their process
environment, use it to resolve the Onclave project, and do not copy it to managed
hosts. Runtime environment files may contain the resolved service credentials
when required by Compose, but they are generated deployment artifacts rather
than a source of truth.

An explicit `ONCLAVE_AMQP_URL` remains a development override. It is not stored
in the operator private archive or homelab values repository.

## menos

menos began as YouTube transcript tooling and is intended to grow into a
centralized memory store and a logging and analytics sink for Pi and Claude
sessions. The goal is evidence-based decisions about which tooling and
extensions actually help, rather than judgement by feel.

This is context for two decisions elsewhere in this document. Discovery matters
because agents on mobile workstations must reach menos without configuration.
Telemetry transport is deferred but not optional, because the value of an
analytics sink depends on a long time series and that series cannot be
backfilled.

Availability expectations rise if menos becomes that sink. It currently runs as
an app workload sharing 16 GB of RAM on the onramp host with SearXNG, RabbitMQ,
onclave-core, Docling, and Ollama. Storage is owner-managed and out of scope
here.

One transport was proposed and withdrawn: shipping session telemetry as onclave
`inform` envelopes over the existing durable per-agent queues. The durability
argument was weaker than it first appeared, because menos and RabbitMQ share a
host and do not fail independently. Client-side spooling, not broker queuing,
would be doing the real work. Recorded so the option is reconsidered on its
merits rather than rediscovered.

## Hermes

Hermes is intended to become the operator cockpit for home infrastructure,
driving `homelab-infra`. It is not being handed control now.

What that requires is not more capability but a machine-readable surface:
`--json` output on `just validate`, `just plan`, and the service-state scripts,
plus exit codes distinguishing clean, drift, blocked-by-gate, and error. Hermes
should report evidence rather than scrape human-formatted text.

The human approval gate on `apply` stays. Hermes proposes and explains; the
operator approves. This matches `homelab-infra/docs/hermes-operator-pilot-prd.md`,
so it is implementation rather than a policy change.

`onramp-vNext` already specifies the same contract for itself at
`onramp-vnext-mvp-scope.md:32-48`: JSON output, plan/apply, and first-class
read-only informational commands. If Hermes is to drive both, they should agree
on one contract rather than each inventing its own.

Hermes remains a first-class service in `homelab-infra` rather than an app
workload, per the existing exception at
`homelab-infra/docs/onramp-app-platform-contract.md`, Hermes paragraph in
App Workload Decisions. Line numbers shifted during the 2026-07-26
reconciliation, so the section is cited rather than a line.

## Deferred

Explicitly not being built now. Recorded so they are not mistaken for
oversights.

| Item | Why deferred |
|---|---|
| Telemetry transport | Telemetry will exist; how it ships is open. The onclave `inform` path was proposed and pulled back, because menos and RabbitMQ share a host and do not fail independently |
| Tailscale and tailnet routing | A separate Tailscale instance already runs outside this work; `tailscale_client_enabled = false` in private values |
| Backup and restore systems | Out of scope until the stack stabilizes and the operator decides what to keep |
| Storage architecture | Owner-managed |
| `onramp-vNext` `init` rework | Deferred until the stack stabilizes, despite the Infisical demotion above |
| Secret provider abstraction | One backend, so premature |
| Porting the legacy service corpus | Catalog schema not stable |
| joyride emitting SRV from labels | One static record covers the current need |

## Cleanup

Known debt, to be folded into implementation plans rather than done as its own
project.

- `homelab-infra` sheds `onclave_onramp`, `menos_onramp`, and `searxng_onramp`
  to `onramp-vNext`. The three bespoke Ansible roles are then **deleted, not
  generalized**. Task file lengths are 252, 467, and 175 lines, plus
  `infisical_onramp` at 187. They share a common skeleton of rendering a
  compose file, an env file, a Caddy snippet, and a systemd unit, but they are
  not interchangeable: `searxng_onramp` has no `.env.j2` and instead carries
  `docker-compose.yml.j2` and `settings.yml.j2`, and `menos_onramp` adds
  authorized keys, model bootstrap, bucket setup, readiness, backup, and
  restore behavior the others do not have. Deletion is still the right call
  once the workloads move, but not because the roles are near-identical.
- `homelab-infra/docs/onramp-app-platform-contract.md` was reconciled against
  this document on 2026-07-26. It gained Provisioning Ownership and Catalog
  Ownership sections, an updated Secrets Contract naming Bitwarden, and exit
  conditions on the three temporary app-workload exceptions. The change is
  uncommitted. It now defers to this PRD rather than restating it, so future
  ownership changes belong here first.
- `homelab-infra` private `values/` holds roughly 2.42 GiB of backup tarballs in
  git history across 101 tracked files, largest a 1.1 GB Forgejo state archive.
  Decision: stop the growth, leave the packfile. No history rewrite.
- `.dotfiles/AGENTS.md:3,13` and `.dotfiles/CLAUDE.md:54-79` document a `menos/`
  submodule that no longer exists and describe SurrealDB, which menos no longer
  uses. `.gitmodules` declares only `dotbot` and `onclave`.
- The former Menos catalog entry declared a `stateOrder` beginning with
  `surrealdb`, while its Compose definition used `postgres`.
  `onclave/scripts/service-catalog.py:49-55` only shape-validates the list.
- `onclave/infra/ansible/files/onclave/docker-compose.yml:25-28` builds from a
  local `./src` context rather than consuming the digest-pinned app definition.
  It appears unused by the active deployment path, which copies the canonical
  definition at `onclave/infra/ansible/playbooks/deploy.yml:166-170`. Confirm it
  is dead before removing it, and audit the other tracked compose variants at
  the same time rather than assuming a fixed count.
- Research documents sit alongside implementation PRDs in both repos, inflating
  the apparent surface. `onramp-vNext/docs/prd/lakebed-backend-architecture-prd.md`
  is 1321 lines of reverse-engineering notes on a third-party product;
  `onclave/docs/PRDS/agentic-software-factory-PRD.md` is similar. A
  `docs/research/` split would help.

## Document Location

Decided 2026-07-27: this document lives in `onclave`, alongside its child PRDs.

It governs six repositories and `onclave` is only one of them, so the choice is
a compromise. It holds because the PRDs stay together, because `onclave` is a
submodule of `.dotfiles` and therefore present in any workstation checkout, and
because `homelab-infra/docs/onramp-app-platform-contract.md` now names this
document by path, giving a signpost from the repository an operator is more
likely to open first.

Revisit if `onramp-vNext` becomes the day-to-day working repository. Do not move
this to `homelab-infra`; these decisions reduce that repository's scope, and the
governing document should not live in the repository losing ground.

## Open Questions

- Should the onclave broker use the same convention? Finding the broker is the
  Pi bootstrap problem, and it would be the second consumer of whatever pattern
  menos establishes.
- When `onramp-vNext` can receive workloads, what is the migration order for the
  three evicted services?
- Does menos becoming a memory and telemetry sink change its placement? It is
  currently an app workload sharing 16 GB with SearXNG, RabbitMQ, onclave-core,
  Docling, and Ollama.

## Sources

Facts were read directly during the 2026-07-26 session. Paths are relative to
each repository root. Items marked private live in the nested private `values/`
repository and are not verifiable without access to it.

| Claim | Source |
|---|---|
| vNext claims Proxmox provisioning in public MVP | `onramp-vNext/docs/prd/onramp-vnext-mvp-scope.md:114-116,126` |
| Infisical is a locked convention | `onramp-vNext/docs/prd/onramp-personal-paas-redesign-prd.md:62`, `onramp-vnext-mvp-scope.md:69` |
| Caddy config is generated, not label-driven | `onramp-vNext/docs/prd/onramp-personal-paas-redesign-prd.md:64` |
| Plans must show route changes | `onramp-vNext/docs/prd/onramp-vnext-mvp-scope.md:40-41` |
| Warning against speculative platform features | `onramp-vNext/docs/prd/onramp-vnext-mvp-scope.md:91-102` |
| Catalog schema, CI validation, checksummed artifact distribution. Signing is explicitly future work (`"type": "none-yet"`) | `onramp-vNext/docs/prd/onramp-catalog-distribution-prd.md:118-119,144-145,264` |
| 278 top-level and 297 recursive service YAML files, 2026-07-27. The repo's own docs say 276 and 287+, so the count is unstable and should be measured, not quoted | `onramp/services-available/` |
| Existing substrate-versus-app ownership contract | `homelab-infra/docs/onramp-app-platform-contract.md:5-13,63-69` |
| Four onramp app roles sharing a common skeleton but differing in detail | `homelab-infra/infra/ansible/roles/{onclave,menos,searxng,infisical}_onramp/` |
| Eight hand-maintained image and definition pins | private `values/ansible/inventory/local.yml`, mirrored in `homelab-infra/scaffold/ansible/inventory/local.yml:101-120` |
| BWS tooling already present | `onclave/scripts/onclave-bws-env.py` |
| former Menos compose used postgres while its catalog said surrealdb | retired app definition vs former `onclave/infra/services.json` |
| Stale menos submodule docs | `.dotfiles/AGENTS.md:3,13`, `.dotfiles/CLAUDE.md:54-79`, `.dotfiles/.gitmodules` |
| Tailscale declared but disabled | private `values/terraform.tfvars:67` |
| onramp host sizing, 16 GB RAM, second 512 GB data disk | private `values/terraform.tfvars:197-205` |
| values/ git history size | `git count-objects -vH` in `homelab-infra/values` |
