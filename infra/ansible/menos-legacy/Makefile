.PHONY: deploy update backup backup-setup reboot shell build logs status test lint \
	version-show version-check version-set version-bump-major version-bump-minor version-bump-patch

VERSION_FILE = api/pyproject.toml

define BUMP_VERSION_PY
import os
import re
from pathlib import Path

path = Path("api/pyproject.toml")
text = path.read_text(encoding="utf-8")
match = re.search(r'(?m)^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"\s*$$', text)
if not match:
    raise SystemExit("Could not find [project].version in api/pyproject.toml")

major, minor, patch = map(int, match.groups())
bump = os.environ.get("BUMP", "")

if bump == "major":
    major, minor, patch = major + 1, 0, 0
elif bump == "minor":
    minor, patch = minor + 1, 0
elif bump == "patch":
    patch += 1
else:
    raise SystemExit(f"Unsupported bump level: {bump}")

next_version = f"{major}.{minor}.{patch}"
updated = text[:match.start()] + f'version = "{next_version}"' + text[match.end():]
path.write_text(updated, encoding="utf-8")
print(next_version)
endef
export BUMP_VERSION_PY

# Ansible container commands
ANSIBLE_CMD = docker compose -f infra/ansible/docker-compose.yml run --rm ansible

# Full deploy: sync files, pull images, start services
deploy:
	$(ANSIBLE_CMD) ansible-playbook playbooks/deploy.yml

# Quick update: pull latest images and restart
update:
	$(ANSIBLE_CMD) ansible-playbook playbooks/update.yml

# Backup current server config
backup:
	$(ANSIBLE_CMD) ansible-playbook playbooks/backup.yml

# Set up data backup infrastructure (cron, script, directories)
backup-setup:
	$(ANSIBLE_CMD) ansible-playbook playbooks/backup-setup.yml

# Reboot remote server (fixes nvidia driver mismatch)
reboot:
	$(ANSIBLE_CMD) ansible-playbook playbooks/reboot.yml

# Interactive shell in Ansible container
shell:
	docker compose -f infra/ansible/docker-compose.yml run --rm --entrypoint /bin/bash ansible

# Build Ansible container
build:
	docker compose -f infra/ansible/docker-compose.yml build

# Local development
dev:
	docker compose -f infra/ansible/files/menos/docker-compose.yml up -d

dev-down:
	docker compose -f infra/ansible/files/menos/docker-compose.yml down

dev-logs:
	docker compose -f infra/ansible/files/menos/docker-compose.yml logs -f

status:
	docker compose -f infra/ansible/files/menos/docker-compose.yml ps

# API development
api-build:
	docker compose -f infra/ansible/files/menos/docker-compose.yml build menos-api

# Run API tests
test:
	cd api && uv run pytest -v

# Run linter
lint:
	cd api && uv run ruff check .

# Format code
fmt:
	cd api && uv run ruff format .

# Test infrastructure
test-infra:
	@echo "Checking Ansible syntax..."
	$(ANSIBLE_CMD) --syntax-check playbooks/deploy.yml
	$(ANSIBLE_CMD) --syntax-check playbooks/update.yml
	$(ANSIBLE_CMD) --syntax-check playbooks/backup.yml
	$(ANSIBLE_CMD) --syntax-check playbooks/backup-setup.yml
	@echo "All playbooks OK"

# Semantic versioning helpers
version-show:
	@python -c "import re; from pathlib import Path; t=Path('$(VERSION_FILE)').read_text(encoding='utf-8'); m=re.search(r'(?m)^version\\s*=\\s*\"([^\"]+)\"\\s*$$', t); print(m.group(1) if m else 'unknown')"

version-check:
	@python -c "import re,sys; from pathlib import Path; t=Path('$(VERSION_FILE)').read_text(encoding='utf-8'); m=re.search(r'(?m)^version\\s*=\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"\\s*$$', t); sys.exit(0 if m else 1)"
	@echo "Semver is valid in $(VERSION_FILE)"

version-set:
	@test -n "$(VERSION)" || (echo "Usage: make version-set VERSION=x.y.z" && exit 1)
	@python -c "import re,sys; from pathlib import Path; v='$(VERSION)'; assert re.fullmatch(r'\\d+\\.\\d+\\.\\d+', v), 'VERSION must be x.y.z'; p=Path('$(VERSION_FILE)'); t=p.read_text(encoding='utf-8'); u=re.sub(r'(?m)^version\\s*=\\s*\"[^\"]+\"\\s*$$', f'version = \"{v}\"', t, count=1); p.write_text(u, encoding='utf-8'); print(v)"

version-bump-major:
	@BUMP=major python -c "$$BUMP_VERSION_PY"

version-bump-minor:
	@BUMP=minor python -c "$$BUMP_VERSION_PY"

version-bump-patch:
	@BUMP=patch python -c "$$BUMP_VERSION_PY"
