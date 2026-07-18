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

gateway-acceptance:
    node ./scripts/gateway-acceptance.mjs

gateway-restart-acceptance:
    ONCLAVE_ACCEPTANCE_RESTART=1 node ./scripts/gateway-acceptance.mjs

gateway-broker-restart-acceptance:
    ONCLAVE_ACCEPTANCE_BROKER_RESTART=1 node ./scripts/gateway-acceptance.mjs

go-rabbitmq-test:
    bash ./scripts/rabbitmq-test.sh

pi-local:
    pi -e ./extensions/onclave-pi

pi-local-no-extensions:
    pi --no-extensions

pi-smoke:
    pnpm exec vitest run extensions/onclave-pi/tests/extension.test.ts
