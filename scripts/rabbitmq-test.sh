#!/usr/bin/env bash
set -euo pipefail

compose_file="infrastructure/docker/onclave-compose.yml"
password="${ONCLAVE_RABBITMQ_PASSWORD:-local-stack-password-change-me}"
export ONCLAVE_RABBITMQ_PASSWORD="$password"

docker compose -f "$compose_file" up -d rabbitmq
rabbitmq_container="$(docker compose -f "$compose_file" ps -q rabbitmq)"
if [[ -z "$rabbitmq_container" ]]; then
  echo "RabbitMQ container was not started" >&2
  exit 1
fi

docker run --rm \
  --network "container:${rabbitmq_container}" \
  -v "$PWD:/src" \
  -w /src/services/onclave \
  -e "ONCLAVE_RABBITMQ_TEST_URL=amqp://onclave:${password}@127.0.0.1:5672/%2Fonclave" \
  golang:1.26-alpine \
  go test ./... -count=1 -v
