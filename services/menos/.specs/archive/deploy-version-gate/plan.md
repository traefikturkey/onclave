# Team Plan: Deploy Version Gate

## Objective
Prevent multi-machine deployment conflicts by ensuring the server always knows what git SHA it's running, and blocking deploys when the local git history doesn't contain the server's current SHA.

**Core problem**: Machine A deploys commit X. Machine B (which hasn't pulled) deploys older commit Y, silently overwriting Machine A's work. No record exists of what was running.

**Solution**: 3-piece version gate in the Ansible deploy pipeline:
1. Bake git SHA into Docker image → expose on `/health`
2. Pre-deploy: check that server's current SHA is an ancestor of local HEAD
3. Pre-deploy: block dirty working trees

## Project Context
- **Language**: Python (FastAPI + Pydantic v2)
- **Test command**: `cd api && uv run pytest`
- **Lint command**: `cd api && uv run ruff check`
- **Deploy tool**: Ansible (runs in Docker container, project mounted at /project)
- **Server**: 192.168.16.241, deploy path /apps/menos

## Files to Modify/Create

### Existing files to modify:
- `api/Dockerfile` — add GIT_SHA + BUILD_DATE build args
- `api/menos/routers/health.py` — return git_sha in /health response
- `infra/ansible/Dockerfile` — install git
- `infra/ansible/playbooks/deploy.yml` — add pre-flight + version gate tasks, pass build-arg
- `infra/ansible/files/menos/docker-compose.yml` — add build args passthrough

### New files:
- `api/tests/unit/test_health.py` — test /health returns git_sha
- `api/tests/integration/test_health.py` — extend existing test for SHA field

## Team Members
| Name | Agent | Role |
|------|-------|------|
| gate-builder | builder (sonnet) | Implement all changes |
| gate-validator | validator (haiku) | Verify output |

## Tasks

### Task 1: Add GIT_SHA to Docker image and /health endpoint
- **Owner**: gate-builder
- **Blocked By**: none
- **Description**:

  **1a. Modify `api/Dockerfile`** — Add build args AFTER the COPY+RUN steps (to preserve layer caching):
  ```dockerfile
  # ... existing COPY and RUN lines stay the same ...

  # Version metadata (placed last to avoid cache busting)
  ARG GIT_SHA=unknown
  ARG BUILD_DATE=unknown
  ENV GIT_SHA=$GIT_SHA
  ENV BUILD_DATE=$BUILD_DATE
  ```

  **1b. Modify `api/menos/routers/health.py`** — Add `os.environ.get("GIT_SHA", "unknown")` and `os.environ.get("BUILD_DATE", "unknown")` to the /health response:
  ```python
  @router.get("/health")
  async def health():
      return {
          "status": "ok",
          "git_sha": os.environ.get("GIT_SHA", "unknown"),
          "build_date": os.environ.get("BUILD_DATE", "unknown"),
      }
  ```
  Import `os` at the top.

  **1c. Add test in `api/tests/unit/test_health.py`**:
  - Test that /health returns `git_sha` and `build_date` keys
  - Test that when GIT_SHA env var is set, it's returned
  - Test that when GIT_SHA env var is unset, "unknown" is returned

  **1d. Update `api/tests/integration/test_health.py`** if it exists — ensure the existing health test still passes with the new response shape (it should, since we're adding fields not removing them, but verify).

- **Acceptance Criteria**:
  - [ ] `api/Dockerfile` has GIT_SHA and BUILD_DATE args after COPY/RUN lines
  - [ ] `/health` returns `{"status": "ok", "git_sha": "...", "build_date": "..."}`
  - [ ] New unit test for health endpoint passes
  - [ ] `cd api && uv run ruff check menos/routers/health.py tests/unit/test_health.py` passes
  - [ ] `cd api && uv run pytest tests/ -v --tb=short` — all tests pass
- **Verification Command**: `cd api && uv run ruff check && uv run pytest --tb=short`

### Task 2: Add version gate to Ansible deploy pipeline
- **Owner**: gate-builder
- **Blocked By**: Task 1
- **Description**:

  **2a. Modify `infra/ansible/Dockerfile`** — Add `git` to the apt-get install line (after rsync):
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-client \
      rsync \
      git \
      && rm -rf /var/lib/apt/lists/*
  ```

  **2b. Modify `infra/ansible/files/menos/docker-compose.yml`** — Add build args to the menos-api service:
  ```yaml
  menos-api:
    build:
      context: ./api
      args:
        GIT_SHA: ${GIT_SHA:-unknown}
        BUILD_DATE: ${BUILD_DATE:-unknown}
    ...
  ```

  **2c. Modify `infra/ansible/playbooks/deploy.yml`** — Add these task blocks BEFORE the existing "Sync API" tasks:

  **Pre-flight block** (runs on localhost/ansible container):
  ```yaml
  # --- Pre-flight checks ---
  - name: Mark git repo as safe directory
    ansible.builtin.command:
      cmd: git config --global --add safe.directory /project
    delegate_to: localhost
    changed_when: false

  - name: Get local git SHA
    ansible.builtin.command:
      cmd: git rev-parse HEAD
      chdir: /project
    delegate_to: localhost
    register: local_git_sha
    changed_when: false

  - name: Get local git branch
    ansible.builtin.command:
      cmd: git rev-parse --abbrev-ref HEAD
      chdir: /project
    delegate_to: localhost
    register: local_git_branch
    changed_when: false

  - name: Check for uncommitted changes
    ansible.builtin.command:
      cmd: git status --porcelain
      chdir: /project
    delegate_to: localhost
    register: git_status
    changed_when: false
    failed_when: git_status.stdout != ""

  - name: Display deploy info
    ansible.builtin.debug:
      msg: "Deploying {{ local_git_sha.stdout[:8] }} ({{ local_git_branch.stdout }}) to {{ ansible_host }}"
  ```

  **Version gate block** (checks server's current SHA):
  ```yaml
  # --- Version gate ---
  - name: Check if API is currently running
    ansible.builtin.uri:
      url: "http://{{ ansible_host }}:8000/health"
      return_content: true
    register: server_health
    failed_when: false
    changed_when: false

  - name: Check ancestry when server has a known SHA
    ansible.builtin.command:
      cmd: "git merge-base --is-ancestor {{ server_health.json.git_sha }} {{ local_git_sha.stdout }}"
      chdir: /project
    delegate_to: localhost
    register: ancestry_check
    changed_when: false
    failed_when: ancestry_check.rc != 0
    when:
      - server_health.status == 200
      - server_health.json.git_sha is defined
      - server_health.json.git_sha != "unknown"
  ```

  **Build command modification** — Change the existing "Build API image" task to pass the SHA:
  ```yaml
  - name: Build API image
    ansible.builtin.command:
      cmd: "docker compose build --build-arg GIT_SHA={{ local_git_sha.stdout }} --build-arg BUILD_DATE={{ ansible_date_time.iso8601 }} menos-api"
      chdir: "{{ deploy_path }}"
    environment:
      GIT_SHA: "{{ local_git_sha.stdout }}"
      BUILD_DATE: "{{ ansible_date_time.iso8601 }}"
    changed_when: true
  ```

  **Post-deploy verification** — Add after the existing "Wait for services" task:
  ```yaml
  - name: Verify deployed version
    ansible.builtin.uri:
      url: "http://{{ ansible_host }}:8000/health"
      return_content: true
    register: post_deploy_health
    retries: 5
    delay: 3
    until: post_deploy_health.status == 200
    changed_when: false

  - name: Confirm SHA matches
    ansible.builtin.assert:
      that:
        - post_deploy_health.json.git_sha == local_git_sha.stdout
      fail_msg: "Deploy verification failed! Expected {{ local_git_sha.stdout }}, got {{ post_deploy_health.json.git_sha }}"
      success_msg: "Deploy verified: {{ post_deploy_health.json.git_sha[:8] }} running on {{ ansible_host }}"
  ```

- **Acceptance Criteria**:
  - [ ] `infra/ansible/Dockerfile` includes `git` in apt-get
  - [ ] `infra/ansible/files/menos/docker-compose.yml` passes GIT_SHA and BUILD_DATE build args
  - [ ] `deploy.yml` has pre-flight block (git SHA capture, dirty tree check)
  - [ ] `deploy.yml` has version gate block (curl /health, ancestry check)
  - [ ] `deploy.yml` passes --build-arg GIT_SHA to docker compose build
  - [ ] `deploy.yml` has post-deploy SHA verification with retries
  - [ ] Ancestry check is skipped when server has no prior deployment (git_sha == "unknown" or /health unreachable)
  - [ ] YAML is syntactically valid (`python -c "import yaml; yaml.safe_load(open('file'))"`)
- **Verification Command**: `cd infra/ansible && python -c "import yaml; yaml.safe_load(open('playbooks/deploy.yml'))"`

### Task 3: Validate all changes
- **Owner**: gate-validator
- **Blocked By**: Task 1, Task 2
- **Description**: Run linters, tests, and content checks on all modified files.

  Checks to run:
  1. `cd api && uv run ruff check` — lint passes
  2. `cd api && uv run pytest --tb=short` — all tests pass
  3. Verify `api/Dockerfile` has ARG GIT_SHA after the RUN line (layer cache optimization)
  4. Verify `infra/ansible/playbooks/deploy.yml` is valid YAML
  5. Verify `infra/ansible/Dockerfile` includes `git` in apt-get
  6. Verify `infra/ansible/files/menos/docker-compose.yml` has GIT_SHA in build args
  7. Verify no hardcoded secrets or debug statements in any changed file
  8. Verify the ancestry check has a `when` condition that skips on first deploy

- **Acceptance Criteria**:
  - [ ] All linters pass
  - [ ] All tests pass
  - [ ] Dockerfile ARG placement is correct (after COPY/RUN)
  - [ ] deploy.yml is valid YAML with all required blocks
  - [ ] No debug statements or hardcoded secrets

## Dependency Graph
```
Task 1 (API: SHA in image + /health) → Task 2 (Ansible: version gate) → Task 3 (validate all)
```
