---
created: 2026-07-18
status: draft
branch: feature/v2-broker-core
related: ./extensions/onclave-comms/v2-implementation-plan.md
---

# Plan: Absorb Menos into Onclave

## Context

Onclave is the factory/product repo (Decision 3); menos is the self-hosted
content vault (FastAPI + SurrealDB + object storage + Ollama embeddings +
SearXNG + docling) with YouTube ingestion and agentic search. The dotfiles
repo replaced its menos submodule with onclave, which removed the embedded
menos checkout without replicating its features. This plan makes onclave
the permanent home for menos code, deployment, and operations, with zero
disruption to the running services on the docker host.

Menos services currently live (up on 192.168.16.241): menos-api,
menos-surrealdb, menos-minio, menos-searxng, menos-docling-serve. The yt
tooling in dotfiles talks to the API over HTTP and is unaffected by where
the source lives.

## Constraints

- The running menos stack and its data at /apps/menos must not be
  disrupted; deploy-path, container names, ports, and volumes stay
  identical until a deliberate change is planned.
- The menos deploy flow currently depends on Infisical at a dead hostname;
  the absorbed deploy uses the Bitwarden Secrets Manager flow already
  built for the onclave stack.
- Onclave's existing gates keep passing: just check (TS suites), v1
  extension untouched, onclave stack deploy unaffected.
- Menos API keeps its own toolchain (uv, pytest, ruff) as a subproject;
  no forced unification with the TS workspace.
- KISS: this plan is feature parity and single-repo ownership, not a
  redesign. Deeper fabric integration (menos as an Onclave agent/MCP
  face) is explicitly deferred.

## Target Layout

```
services/
  core/            # TS broker core (existing)
  menos/           # FastAPI app (from menos repo api/)
infra/ansible/
  playbooks/
    deploy.yml         # onclave stack (existing)
    deploy-menos.yml   # menos stack (ported)
    backup-menos.yml   # ported from menos backup.yml if still wanted
  files/menos/         # compose, garage.toml, searxng config (ported)
docs/menos/            # menos docs (ported)
scripts/
  onclave-bws-env.py   # generalized: per-stack required-key sets
```

## Execution

This plan is executed with Pi sessions working in the
`~/.dotfiles/onclave` submodule checkout (branch
`feature/v2-broker-core`). Work commits and pushes from the submodule as
a normal git checkout; bump the dotfiles submodule pin after each phase
gate passes. Phase M0 step 1 (`git subtree add`) must run with the repo
root as cwd. Validation commands per phase are listed in the gates.

## Phases

### Phase M0: Source import

1. Import the menos repo into onclave with history via git subtree
   (`git subtree add --prefix=services/menos-import <ilude/menos> main`),
   then move contents into place: `api/` -> `services/menos`, `docs/` ->
   `docs/menos`, `infra/ansible/files/menos` -> `infra/ansible/files/menos`,
   remaining menos ansible kept temporarily under
   `infra/ansible/menos-legacy/` for reference during M1.
2. Add just targets: `menos-test` (uv run pytest), `menos-lint`
   (uv run ruff check).
3. Guard rails: confirm vitest/tsc globs do not pick up the Python tree;
   pyproject exclusions as needed.

Gate: `just menos-test` green (same result as in the menos repo);
`just check` unchanged; dotfiles submodule bump restores menos source
under ~/.dotfiles/onclave (non-starter resolved).

### Phase M1: Deployment parity on the onclave harness

> Superseded in part by ./infra-alignment-plan.md: menos deployment lands
> as an app definition plus catalog entry on the aligned harness (phases
> A0-A2), not a 1:1 port of the legacy menos playbook. The gate below
> (identical stack, health git_sha, yt smoke, no data loss) still applies.

1. Port deploy.yml from the menos repo to
   `infra/ansible/playbooks/deploy-menos.yml` on the onclave harness:
   same target host, same /apps/menos deploy path, same container names,
   same compose files, same version/ancestry gate against the API
   /health git_sha.
2. Replace the Infisical preflight with the Bitwarden flow: extend
   `scripts/onclave-bws-env.py` to take a stack spec (onclave vs menos
   required/optional key sets); operator creates the Menos secrets in
   Bitwarden (SurrealDB and S3 credentials, `SEARXNG_SECRET`, Webshare
   credentials, `YOUTUBE_API_KEY`, and provider keys).
3. Resolve the storage question (open question 1) before first deploy:
   the menos repo carries both MinIO (live) and Garage
   (compose.migration + migrate-s3 playbook); port only the canonical
   path.
4. `just menos-deploy` target; ansible-lint at production profile.

Gate: real deploy from onclave produces an identical stack: /health 200
with matching git_sha, yt pipeline smoke passes (ingest or content fetch
through the API), no data loss (volumes untouched).

Secret prerequisite completed 2026-07-18: Onclave and Menos required values
exist in Bitwarden, both stack specifications validate, and the live Menos
runtime env is rendered from Bitwarden with the pre-migration env preserved as
`.env.bak`. The full M1 deployment gate remains pending.

### Phase M2: Consolidation

1. CI: add a python job (uv sync + pytest + ruff) alongside the TS jobs;
   path-filter so menos changes do not rebuild TS and vice versa if CI
   time warrants.
2. Docs: onclave README gains the menos subsystem section; menos README
   and operator docs land under docs/menos; deployment docs point at the
   onclave harness. Remove `infra/ansible/menos-legacy/`.
3. Port the active daily data backup as `backup-menos.yml`; retire the
   unreferenced configuration snapshot and quick-update playbooks.

Gate: CI green including the python job; docs reviewed; legacy dir gone.

### Phase M3: Retirement and cleanup

1. Archive the ilude/menos repo (operator; final commit points at
   onclave).
2. Backlog cleanup recorded: stale infisical.ilude.com DNS record and the
   dead .26 LXC decision, menos-repo Infisical role gone with the
   archive.
3. Status doc updated; dotfiles submodule bumped to the completed state.

Gate: menos deploys run only from onclave; old repo archived.

### Deferred (explicitly out of scope)

- Menos as a first-class Onclave fabric participant (agent card, MCP
  face, or webhook bridge onto the broker).
- Storage migration (MinIO -> Garage) beyond porting whichever path is
  already canonical.
- Any API or schema changes to menos itself.

## Decisions

1. Object storage stays on the deployed MinIO (decided 2026-07-18). The
   Garage migration compose/playbook are not ported. Migration to Garage
   or another containerized S3-compatible service remains allowed as a
   future, separately planned change; nothing in the ported deploy may
   assume MinIO beyond the S3_* env contract.
2. The active daily SurrealDB and MinIO backup is retained (decided
   2026-07-18). Read-only host checks confirmed the root cron, successful
   daily logs, 30-day retention, and current backup artifacts. Repository
   and host automation checks found no references to the configuration
   snapshot or quick-update playbooks, so both are retired.
3. The menos import preserves full history through the subtree merge
   (decided 2026-07-18).

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Deploy divergence during port | broken menos deploy while old repo is archived | old repo stays until M1 gate passes; legacy ansible kept in-tree for reference until M2 |
| Secret migration gaps | menos stack fails to start | renderer validates required keys before any remote action; .env backup task preserved |
| Python/TS tooling interference | broken just check or CI | M0 gate explicitly checks both toolchains side by side |
| Storage question decided implicitly | wrong S3 backend ported | M1 blocks on open question 1 |
