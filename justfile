set shell := ["bash", "-uc"]
# On Windows, plain "bash" resolves to the System32 WSL launcher when just is
# invoked from PowerShell; "sh" resolves to Git Bash's sh with no collision.
set windows-shell := ["sh", "-uc"]

preflight:
    bash ./scripts/preflight.sh

preflight-repo:
    node ./scripts/preflight.mjs

setup:
    pnpm install

test:
    pnpm test

typecheck:
    pnpm typecheck

check:
    pnpm typecheck && pnpm test

up:
    docker compose -f docker/compose.yaml up -d --build

down:
    docker compose -f docker/compose.yaml down

logs:
    docker compose -f docker/compose.yaml logs -f --tail=100

core-dev:
    pnpm --filter onclave-core dev

test-integration:
    docker compose -f docker/compose.test.yaml up -d --wait
    ONCLAVE_TEST_AMQP_URL=amqp://onclave:onclave-test@localhost:5673/onclave pnpm exec vitest run --config vitest.integration.config.ts || (docker compose -f docker/compose.test.yaml down -v; exit 1)
    docker compose -f docker/compose.test.yaml down -v

pi-local:
    pi -e ./extensions/onclave-comms

pi-local-v2:
    pi -e ./extensions/onclave-pi

pi-local-no-extensions:
    pi --no-extensions

pi-smoke:
    pnpm exec vitest run extensions/onclave-comms/tests/extension.test.ts
