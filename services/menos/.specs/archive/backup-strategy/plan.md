---
created: 2026-02-11
completed: 2026-02-12
---

# Team Plan: Backup Strategy

## Objective
Implement automated daily backups of the Menos vault data (SurrealDB + MinIO) to the local server filesystem with retention policy and restore documentation.

**Core problem**: No backup mechanism exists. Data loss from container failure, accidental deletion, or corruption would be unrecoverable.

**Solution**: Server-side backup automation via Ansible-managed cron job:
1. Shell script that exports SurrealDB database and syncs MinIO data to timestamped backup directory
2. Ansible playbook to deploy backup script and configure cron schedule
3. 30-day retention policy (automated cleanup of old backups)
4. Restore documentation for recovery procedures

## Project Context
- **Language**: Shell/Bash (backup script), Ansible YAML (deployment)
- **Test command**: Manual verification (run backup script, verify files created)
- **Lint command**: `shellcheck` for shell scripts, `ansible-lint` for playbooks (if available)
- **Server**: 192.168.16.241, user: anvil, deploy path: /apps/menos
- **Data path**: `/apps/menos/data` (configurable via DATA_PATH env var)
- **Backup destination**: `/backups/menos/YYYY-MM-DD/` (timestamped directories)
- **Docker containers**: menos-surrealdb, menos-minio, menos-api, menos-ollama

## Complexity Analysis
**Low complexity** - Infrastructure automation task with well-defined scope:
- Single backup script (50-100 lines shell)
- Single Ansible playbook (30-50 lines YAML)
- No API changes, no application code changes
- Manual restore procedure (documented, not automated)

**Risks**:
- SurrealDB export command syntax needs verification (Docker exec + credentials)
- MinIO data volume path needs confirmation (check actual mount point)
- Backup size monitoring not included (future enhancement)

## Team Members
| Name | Agent | Role |
|------|-------|------|
| backup-builder | builder (sonnet) | Implement backup script, playbook, documentation |

## Execution Waves
**Single wave** - All tasks can be completed sequentially by one agent.

## Tasks

### Task 1: Research SurrealDB export command
- **Owner**: backup-builder
- **Blocked By**: none
- **Description**:
  Determine the correct SurrealDB export command for Docker containerized deployment.

  **Investigation steps**:
  1. Check SurrealDB documentation for export syntax
  2. Verify required parameters: connection URL, credentials, namespace, database, output format
  3. Test command format for Docker exec context (exec into container vs. external connection)
  4. Document example command with placeholders

  **Expected command format** (to be verified):
  ```bash
  docker exec menos-surrealdb surreal export \
    --endpoint http://localhost:8000 \
    --username root \
    --password "${SURREALDB_PASSWORD}" \
    --namespace menos \
    --database menos \
    /tmp/backup.surql

  docker cp menos-surrealdb:/tmp/backup.surql /backups/menos/YYYY-MM-DD/database.surql
  ```

- **Acceptance Criteria**:
  - [ ] SurrealDB export command documented with all required parameters
  - [ ] Command tested against running container (manual test, document in task notes)
  - [ ] Export produces valid .surql file that can be imported

### Task 2: Create backup script
- **Owner**: backup-builder
- **Blocked By**: Task 1
- **Description**:
  Create `infra/scripts/backup.sh` to perform full data backup.

  **Script requirements**:
  1. Accept optional date parameter (default: today, for manual historical backups)
  2. Create timestamped backup directory: `/backups/menos/YYYY-MM-DD/`
  3. Export SurrealDB database to `database.surql`
  4. Copy MinIO data directory to `minio/` subdirectory (via `docker cp` or rsync of mounted volume)
  5. Create backup manifest file with metadata (timestamp, sizes, container versions)
  6. Delete backups older than 30 days
  7. Log all operations with timestamps
  8. Exit with non-zero status on any failure

  **Environment variables** (read from /apps/menos/.env or passed as args):
  - `SURREALDB_PASSWORD` - Database password
  - `DATA_PATH` - Base data directory (default: /apps/menos/data)
  - `BACKUP_PATH` - Backup destination (default: /backups/menos)
  - `RETENTION_DAYS` - How many days to keep (default: 30)

  **Script structure**:
  ```bash
  #!/bin/bash
  set -euo pipefail

  # Configuration
  BACKUP_DATE="${1:-$(date +%Y-%m-%d)}"
  BACKUP_ROOT="${BACKUP_PATH:-/backups/menos}"
  BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_DATE}"

  # Functions
  log() { echo "[$(date -Iseconds)] $*"; }

  # Create backup directory
  # Export SurrealDB
  # Copy MinIO data
  # Create manifest
  # Cleanup old backups
  ```

- **Acceptance Criteria**:
  - [ ] Script created at `infra/scripts/backup.sh` with execute permissions
  - [ ] Script creates timestamped backup directory
  - [ ] SurrealDB export successful (uses command from Task 1)
  - [ ] MinIO data copied to backup directory
  - [ ] Manifest file created with backup metadata
  - [ ] Old backups deleted (retention policy enforced)
  - [ ] All operations logged to stdout (suitable for cron)
  - [ ] Script exits non-zero on failure
  - [ ] `shellcheck infra/scripts/backup.sh` passes (no warnings)
- **Verification Command**: `cd /c/Projects/Personal/menos && shellcheck infra/scripts/backup.sh`

### Task 3: Create Ansible backup playbook
- **Owner**: backup-builder
- **Blocked By**: Task 2
- **Description**:
  Create or update `infra/ansible/playbooks/backup-setup.yml` to deploy backup infrastructure.

  **Playbook tasks**:
  1. Create backup directory on server (`/backups/menos/`)
  2. Ensure directory has correct permissions (anvil user)
  3. Copy backup script to server (`/apps/menos/scripts/backup.sh`)
  4. Set execute permissions on script
  5. Install cron job (daily at 3 AM UTC)
  6. Verify cron job is registered
  7. Optional: Run initial backup to verify setup

  **Cron job specification**:
  ```
  # Daily backup at 3 AM UTC
  0 3 * * * /apps/menos/scripts/backup.sh >> /var/log/menos-backup.log 2>&1
  ```

  **Note**: Existing `backup.yml` playbook backs up config files, not data. This is a separate playbook for data backups.

- **Acceptance Criteria**:
  - [ ] Playbook created at `infra/ansible/playbooks/backup-setup.yml`
  - [ ] Backup directory created on server with correct permissions
  - [ ] Backup script deployed to server
  - [ ] Cron job installed and active
  - [ ] Playbook is idempotent (safe to run multiple times)
  - [ ] YAML syntax valid
  - [ ] Optional verification task runs test backup
- **Verification Command**: `cd /c/Projects/Personal/menos/infra/ansible && python -c "import yaml; yaml.safe_load(open('playbooks/backup-setup.yml'))"`

### Task 4: Document restore procedure
- **Owner**: backup-builder
- **Blocked By**: Task 2
- **Description**:
  Add restore documentation to the spec file (this file, append section after tasks).

  **Documentation requirements**:
  1. How to list available backups
  2. How to restore SurrealDB from backup (surreal import command)
  3. How to restore MinIO data from backup
  4. How to verify restore success
  5. Recovery scenarios (full disaster recovery, selective restore, point-in-time recovery)

  **Add new section before "Dependency Graph"**:
  ```markdown
  ## Restore Procedures

  ### List Available Backups
  ### Restore SurrealDB Database
  ### Restore MinIO Data
  ### Verify Restore Success
  ### Recovery Scenarios
  ```

- **Acceptance Criteria**:
  - [ ] Restore section added to spec file
  - [ ] SurrealDB import command documented with example
  - [ ] MinIO restore procedure documented
  - [ ] Verification steps documented
  - [ ] Common recovery scenarios covered

### Task 5: Integration and verification
- **Owner**: backup-builder
- **Blocked By**: Task 3, Task 4
- **Description**:
  Deploy backup setup to server and verify end-to-end functionality.

  **Verification steps**:
  1. Run `backup-setup.yml` playbook via Ansible
  2. Verify cron job installed: `ssh anvil@192.168.16.241 'crontab -l'`
  3. Trigger manual backup: `ssh anvil@192.168.16.241 '/apps/menos/scripts/backup.sh'`
  4. Verify backup files created in `/backups/menos/YYYY-MM-DD/`
  5. Check backup manifest contains expected metadata
  6. Verify log output shows successful operations
  7. Test restore procedure on test data (optional, document results)

- **Acceptance Criteria**:
  - [ ] Playbook deployed successfully
  - [ ] Cron job visible in `crontab -l`
  - [ ] Manual backup run produces valid backup files
  - [ ] SurrealDB export file exists and is non-empty
  - [ ] MinIO data copied successfully
  - [ ] Manifest file contains correct metadata
  - [ ] No errors in backup log output
  - [ ] Restore documentation validated (at least SurrealDB import tested)

## Dependency Graph
```
Task 1 (Research SurrealDB export)
  → Task 2 (Create backup script)
    → Task 3 (Ansible playbook)
    → Task 4 (Restore documentation)
      → Task 5 (Integration & verification)
```

## Notes
- Ollama model data is NOT backed up (large, can be re-pulled)
- API container has no persistent state (stateless, rebuild from source)
- Backup script logs to stdout for cron capture (`>> /var/log/menos-backup.log 2>&1`)
- Future enhancements: backup size monitoring, compression, off-site backup, incremental backups

## Future Enhancements (Out of Scope)
- Backup compression (gzip/tar)
- Off-site backup sync (rsync to remote server, S3, etc.)
- Backup size/age monitoring alerts
- Incremental backups (only changed data)
- Automated restore testing
- Backup encryption
