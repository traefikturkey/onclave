---
created: 2026-07-18
status: draft
branch: feature/v2-broker-core
related:
  - ./menos-absorption-plan.md
  - ./infra-alignment-plan.md
---

# Plan: Menos Data Migration and Legacy Deployment Cleanup

## Context

The legacy menos stack (menos-api, menos-surrealdb, menos-minio,
menos-searxng, menos-docling-serve) runs at /apps/menos on the legacy
docker host with a root-cron daily backup (30-day retention, verified
during absorption M-phase work). The new menos deployment lands through
homelab-infra (`menos_onramp`, infra-alignment plan Phase A3) under
ilude.com names. This plan moves the data, proves functionality, and
retires the legacy deployment without losing anything.

## Preconditions (do not start before all hold)

1. Infra-alignment Stage 1 (Phases A0-A2) complete: menos app definition
   exists, Joyride labels removed, gates green.
2. Infra-alignment Stage 2 (Phase A3) complete: `menos_onramp` service
   deployed through homelab-infra's approved workflow; the new stack is
   reachable at its ilude.com names with empty/fresh data stores.
3. Menos absorption M0-M2 complete (quality gates, backup automation
   ported); ilude/menos repo NOT yet archived (M3 waits on this plan).
4. Topology resolved from homelab-infra values: whether the new stack
   shares the legacy host. Same-host: resolve port/path collisions by
   stopping the legacy stack at the cutover step (C4) before starting
   the new stack on final ports; the export in C1 must complete first.
   Cross-host: stacks coexist; no collision handling needed.

## Migration Inventory

Stateful (must migrate):
- SurrealDB: metadata, embeddings, HNSW indexes (namespace/database
  `menos`).
- MinIO: bucket `menos` object storage.
- API auth: `keys/authorized_keys` (RFC 9421 registered public keys).

Recreatable (no migration): Ollama models (`mxbai-embed-large`,
`qwen3:latest` - pull on new host), SearXNG, docling-serve, containers
themselves. Backup automation must be re-verified on the new stack, not
copied blindly.

## Phases

### Phase C1: Fresh export with quiesced writes

1. Verify the daily backup succeeded within the last 24h (cron log,
   artifact timestamps).
2. Quiesce ingestion: stop or pause menos-api (read-only window) so the
   export is consistent; record the window in the run log.
3. Take an explicit dated snapshot to a staging directory on the legacy
   host: SurrealDB export (same mechanism as the ported backup), MinIO
   bucket mirror (mc mirror or the backup path), copy of
   keys/authorized_keys.
4. Build a migration manifest: SurrealDB record counts per table,
   MinIO object count and total bytes, checksums for the export
   artifacts. Store the manifest with the snapshot and commit a copy
   (counts only, no data) to the run notes.
5. Restart menos-api; legacy service resumes normally (no user-visible
   outage beyond the quiesce window).

Gate: snapshot artifacts exist with checksums; manifest recorded;
legacy API healthy again.

### Phase C2: Restore into the new stack

1. Transfer the snapshot to the new stack's host/path (skip if
   same-host).
2. Import the SurrealDB export into the new SurrealDB; verify HNSW
   index availability after import (rebuild if the import does not
   restore index state).
3. Mirror MinIO objects into the new MinIO bucket; verify object count
   and bytes against the manifest.
4. Install authorized_keys into the new API's key path; pull Ollama
   models on the new host.

Gate: new-stack counts match the manifest exactly; new API /health 200
with expected git_sha.

### Phase C3: Functional validation on the new stack

1. Signature auth: a signed request with an existing registered key
   succeeds.
2. Content retrieval: fetch a known document by id; byte-compare
   against the legacy response.
3. Semantic search: run 3 recorded queries against BOTH stacks; top
   results must match (allowing score jitter only).
4. YouTube pipeline end to end: ingest a test video through the new
   API; job completes; transcript/content retrievable.
5. Backup automation: trigger one on-demand run of the ported backup on
   the new stack; artifact appears with retention policy in place.

Gate: all five checks pass and are recorded in the run notes.

### Phase C4: Cutover

1. Switch consumers: dotfiles yt tooling MENOS_API_BASE (and any other
   recorded consumers) to the new ilude.com name; verify a real yt
   command round-trips.
2. Stop (do not remove) the legacy stack: `docker compose stop` at
   /apps/menos; disable the legacy backup cron so it does not alarm on
   a stopped database.
3. Soak: 7 days with the legacy stack stopped but intact. Any
   regression: restart legacy stack, repoint consumers, return to C3.

Gate: soak period passes with the new stack serving all menos traffic.

### Phase C5: Decommission (operator approval required; destructive)

1. Final archival snapshot of the stopped legacy data directory into
   the managed backup location; verify checksum.
2. Remove legacy containers and /apps/menos on the old host; remove
   legacy DNS/Joyride leftovers for menos names on the old host.
3. Close menos absorption M3: archive ilude/menos, record cleanup in
   the status docs, bump the dotfiles submodule pin.

Gate: legacy host carries no menos services or data; archives verified;
docs updated.

## Rollback

C1-C3 touch only snapshots and the new stack: abandon freely. C4 is
reversible by restarting the stopped legacy stack and repointing
consumers. After C5 the recovery path is the archival snapshot restore;
C5 therefore requires the soak period and explicit operator approval.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Export taken mid-write | inconsistent restore | quiesce window in C1; counts manifest verified at C2 |
| HNSW index not rebuilt on import | silent bad search results | explicit index verification plus C3 search-parity check |
| Same-host port collision | new stack cannot start | precondition 4 resolves topology; same-host path stops legacy first, after export |
| Consumers missed at cutover | stale traffic to stopped stack | consumer inventory in C4 run notes; soak period catches stragglers |
| Premature deletion | data loss | C5 gated on soak plus operator approval plus verified archival snapshot |
