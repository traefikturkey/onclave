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
    pi -e ./extensions/onclave-comms

pi-local-no-extensions:
    pi --no-extensions

pi-smoke:
    bun test extensions/onclave-comms/tests/extension.test.ts
