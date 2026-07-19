---
created: 2026-07-18
status: draft
branch: feature/v2-broker-core
related:
  - ./menos-absorption-plan.md
  - homelab-infra docs/onramp-app-platform-contract.md
---

# Plan: Align Onclave Deployment with the Homelab Infra Contract

## Context

The homelab ecosystem already has a written ownership doctrine
(homelab-infra `docs/onramp-app-platform-contract.md`): homelab-infra owns
durable substrate (Proxmox, DNS, first-class LXC services, OpenTofu
state), the onramp app platform owns Docker app workloads, and Hermes is a
cockpit with no source-of-truth state. Onclave (broker core + rabbitmq,
and menos after absorption) is an app workload under that taxonomy.

Onclave's current `infra/ansible` harness (adapted from menos) deploys by
SSHing the docker host directly - a contract bypass, acceptable only as a
recorded temporary exception like `searxng_onramp`. Separately,
homelab-infra demonstrates the mature shareable-repo mechanics onclave
should adopt: public-safe tracked source with placeholders, a nested
private `values/` git repo, `scaffold/` starter files, a
`settings.local.json`, a service catalog (`infra/services.json`) driving
just verbs, containerized tooling with pinned images, and a
public-safety check.

This plan updates onclave to (1) publish a host-agnostic app definition as
the reuse seam, (2) adopt the homelab-infra values/scaffold/catalog
mechanics, and (3) define the homelab-infra-side consumption path, so
other users can take any piece independently.

## Constraints

- No disruption to running services; live mutation only through reviewed
  steps, mirroring homelab-infra's validate/plan/approve discipline.
- The menos absorption plan (./menos-absorption-plan.md) continues; this
  plan supersedes its Phase M1 deployment detail: menos deploys land as a
  second app definition plus catalog entry, not a 1:1 port of the legacy
  menos playbook.
- Existing gates keep passing: just check, v1 extension untouched,
  local-dev compose (docker/compose.yaml) unchanged as the dev path.
- Secrets: app env-key contracts are provider-agnostic; Bitwarden Secrets
  Manager is one provider, a hand-written env file is another.
  Infrastructure secrets remain with homelab-infra/values per the
  contract.
- Public-safety: tracked onclave files currently contain the real docker
  host IP, SSH user, and deploy paths (infra/ansible/inventory/hosts.yml).
  Under the adopted doctrine these move to private values; tracked files
  use placeholders (RFC 5737 addresses, example hostnames).

## Target Shape

```
onclave repo (public):
  deploy/app/onclave/       # app definition: compose, env contract,
                            # healthcheck docs, image references
  deploy/app/menos/         # same shape after absorption (M-plan)
  infra/                    # thin harness: catalog-driven, values-backed
    services.json           # onclave, menos stacks; deps and order
    ansible/                # app-deploy roles usable directly or by
                            # homelab-infra; no site specifics tracked
  scaffold/                 # public-safe starter for onclave-values
  values/                   # ignored nested private git repo (site IPs,
                            # SSH user, deploy paths, secret provider cfg)
homelab-infra repo:
  onclave_onramp service    # catalog entry + role consuming the onclave
                            # app definition (later; Phase A3)
```

## Execution

Executed with Pi sessions in the ~/.dotfiles/onclave submodule checkout
(branch feature/v2-broker-core), same conventions as the menos absorption
plan. Phases A0-A2 are onclave-repo work. Phase A3 touches homelab-infra
and requires its reviewed workflow and operator approval. Bump the
dotfiles submodule pin after each phase gate.

## Phases

### Phase A0: App definition as the reuse seam

1. Create `deploy/app/onclave/`: production compose (rabbitmq +
   onclave-core) parameterized only by env; `env-contract.md` listing
   required keys (RABBITMQ_DEFAULT_USER, RABBITMQ_DEFAULT_PASS) and
   optional tuning keys; health semantics (`/health` broker connectivity)
   documented for any consuming platform.
2. CI publishes the onclave-core image to a registry (GHCR under the
   repo's org) on branch pushes, tagged by SHA; the app compose references
   the image with tag-and-digest, with a build-from-source override for
   dev.
3. Generalize `scripts/onclave-bws-env.py` into a provider-seam renderer:
   stack spec (required/optional keys) as input; providers: bws, plain
   env file. Validation logic unchanged.

Gate: `docker compose config` clean for the app definition with a sample
env; CI image build+push green; renderer unit-validated for both
providers; just check green.

### Phase A1: Values split and public safety

1. Add `scaffold/` (inventory template with RFC 5737 placeholder address,
   example SSH user, deploy paths, secret-provider selection) and
   `settings.example.json` for the private values repo remote.
2. Move site specifics out of tracked files into an ignored nested
   `values/` git repo (onclave-values, private Forgejo remote): inventory
   host/user, deploy paths, BWS server URLs/org id. Rewrite tracked
   inventory/group_vars to read from values.
3. Port homelab-infra's public-safety check pattern (script scanning
   tracked files for private addresses/hostnames) into onclave's just
   verbs and CI.
4. Purge the already-tracked site specifics from tracked files going
   forward (history rewrite explicitly out of scope; the values are
   RFC 1918 and a username, recorded as accepted).

Gate: public-safety check passes on tracked source; `just deploy-syntax`
and `deploy-lint` pass with scaffold placeholder values; a fresh-checkout
flow (`just setup`-equivalent: clone/init values, validate) works.

### Phase A2: Catalog-driven harness

1. Add `infra/services.json` (onclave stack now; menos stack when the
   absorption reaches deployment) with dependencies and state order,
   driving just verbs: `just deploy <service>`, `just validate`.
2. Align the tooling container with homelab-infra conventions where they
   pay: host uid/gid mapping, pinned base image with checksums,
   ansible-lint in the image (already present), gitleaks retained.
3. Record the contract exception in-repo and in the homelab-infra
   contract doc: onclave deploys itself directly until Phase A3 or
   onramp-vNext ownership; exception includes its removal condition.
4. Menos absorption M1 re-pointed at this mechanism (app definition +
   catalog entry); legacy menos playbook stays in menos-legacy for
   reference only.

Gate: catalog-driven deploy reaches the existing /srv/onclave stack with
identical results (health verified); ansible-lint production profile;
just check green.

### Phase A3: Homelab-infra consumption path (separate repo, approval-gated)

1. Add `onclave_onramp` (and `menos_onramp` when its app definition is
   ready) to homelab-infra following the
   `searxng_onramp`/`infisical_onramp` pattern: services.json entry with
   `onramp_host` dependency, role that consumes the app definition
   (pinned image digest + env contract). DNS per Decision 1: real
   apps.example.net records in homelab-infra-values (Technitium), placeholders
   in tracked files; the AMQP port publishes for LAN adapters, HTTP
   surfaces behind the app host's Caddy per operator choice.
2. Secrets: the role renders the env contract from homelab-infra's
   mechanism (values/ or its selected store); onclave's BWS provider
   remains for standalone users.
3. On acceptance (Decision 1), retire onclave's direct-ssh deploy
   playbook and inventory entirely; onclave keeps the app definitions
   and the local-dev compose. Standalone users consume the app
   definition on their own hosts.
4. Update the app-platform contract: onclave and menos named as app
   workloads; exception closed or transferred to onramp-vNext when that
   platform is ready.
5. Operator cutover tasks recorded: dotfiles ONCLAVE_AMQP_URL and yt
   MENOS_API_BASE switch to the apps.example.net names.

Gate: homelab-infra `just validate` + reviewed plan + approved apply
deploys the onclave stack; adapters on workstations connect via the
apps.example.net DNS name; onclave repo carries no live-mutation path against
any shared host.

### Phase A4: Service moves out of homelab-infra (decisions, not code)

Reviewed candidates, for operator decision, executed only through
homelab-infra's own planned waves:

- Hermes: an agent workload by nature and the strongest candidate for the
  Onclave fabric long-term, but the contract deliberately positions it as
  the cross-cutting cockpit, and its deployment carries pinned-wheel
  integrity machinery. Recommendation: leave deployment in homelab-infra
  now; revisit when Onclave's webhook/MCP faces exist and Hermes can join
  the fabric as an agent (deferred goal in the v2 PRD). Record as a
  standing decision item, not a migration.
- searxng_onramp: destined for onramp per its existing exception; not an
  onclave concern. No action here.
- infisical / infisical_onramp, technitium, forgejo, tailscale, runner,
  onramp_host: durable substrate; stay.

Gate: decisions recorded in the contract doc and here; no unplanned
migrations.

## Decisions

1. Platform and domain (decided 2026-07-18): onclave and menos deploy
   through homelab-infra's mechanics onto the homelab-infra-managed app
   host, with DNS under the operator's real domain (apps.example.net) managed as
   Technitium records in homelab-infra's private values - not the legacy
   docker host's Joyride/apps.example.net publication. Consequences:
   - The Joyride `joyride.host.name` labels in
     `infra/ansible/files/{onclave,menos}/docker-compose.yml` are
     removed; app definitions carry no DNS mechanism at all - naming is
     consumer-owned (homelab-infra records, or whatever a standalone user
     runs).
   - Phase A3 is the primary deployment path, not an optional endpoint;
     onclave's direct-ssh playbook is retired at the A3 gate instead of
     retained as a standalone alternative. Standalone users get the app
     definition (compose + env contract) and bring their own host.
   - The first production deploy of the onclave stack happens through
     homelab-infra (nothing has shipped via the direct path; it stays
     that way).
   - Tracked files keep public-safe placeholders (apps.example.net
     style); real apps.example.net names live only in homelab-infra-values.
   - Workstation adapter URLs (dotfiles private/secrets.env
     ONCLAVE_AMQP_URL) and the yt tooling MENOS_API_BASE cut over to the
     apps.example.net names when their homelab-infra services go live.
2. Broker exposure (closes former open question 3): AMQP is not HTTP, so
   the broker's 5672 publishes as a TCP port with a Technitium A/CNAME
   record; HTTP surfaces (/health, management UI, menos API) may sit
   behind the app host's Caddy per homelab-infra conventions.

## Open Questions

1. Registry/org: GHCR under traefikturkey vs ilude for published images;
   affects the app definition references.
2. onclave-values remote: private Forgejo (matching homelab-infra-values)
   assumed; confirm. With the direct-ssh path retired, onclave-values
   shrinks to standalone-user scaffolding only.
3. Does onramp-vNext want the onclave/menos app definitions directly
   (skipping the homelab-infra role), and on what timeline?
4. Which host does homelab-infra's onramp_host inventory designate today
   (the existing docker host vs the planned Debian 13 Podman VM), and is
   it ready to receive these stacks? Resolve from homelab-infra values
   before A3 planning; do not hardcode a host in onclave.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Two deploy paths during A2-A3 | drift between standalone and homelab-infra paths | single app definition consumed by both; roles contain no app logic |
| Values migration breaks deploys | broken onclave deploy | A1 gate requires fresh-checkout flow plus placeholder lint before any live run |
| Contract exception outlives its welcome | permanent bypass of the platform boundary | exception recorded with explicit removal condition in both repos |
| Menos plan divergence | conflicting deployment work | M1 superseded-by note added to the menos plan in the same commit as this doc |
