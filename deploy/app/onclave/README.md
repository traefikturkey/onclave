# Onclave App Definition

This directory is the reusable production boundary for RabbitMQ and
`onclave-core`. It contains no host inventory, DNS labels, private domain
names, or secret-provider assumptions.

## Validate

```bash
docker compose \
  --env-file deploy/app/onclave/.env.example \
  -f deploy/app/onclave/compose.yaml \
  config --quiet
```

## Build from source

The production compose requires an immutable registry image. For local image
validation, layer on the build override:

```bash
docker compose \
  --env-file deploy/app/onclave/.env.example \
  -f deploy/app/onclave/compose.yaml \
  -f deploy/app/onclave/compose.build.yaml \
  build onclave-core
```

## Health contract

`GET /health` on port 8080 must return HTTP 200 and report:

- `broker.connected: true`
- `broker.topologyDeclared: true`

RabbitMQ must pass `rabbitmq-diagnostics -q ping` before the core starts.
Consumers own DNS, TLS termination, host placement, and persistent-volume
implementation.
