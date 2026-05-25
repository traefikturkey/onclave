set shell := ["bash", "-uc"]

setup:
    pnpm install

test:
    pnpm test

typecheck:
    pnpm typecheck

check:
    pnpm typecheck && pnpm test

pi-local:
    pi -e ./extensions/pi-onclave

pi-local-no-extensions:
    pi --no-extensions

pi-smoke:
    bun test tests/onclave/extension.test.ts
