set shell := ["bash", "-uc"]

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

pi-local:
    pi -e ./extensions/onclave-comms

pi-local-no-extensions:
    pi --no-extensions

pi-smoke:
    pnpm exec vitest run extensions/onclave-comms/tests/extension.test.ts
