# Build context is the repo root so workspace manifests resolve.
FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY extensions/onclave-comms/package.json extensions/onclave-comms/
COPY extensions/onclave-pi/package.json extensions/onclave-pi/
COPY packages/envelope/package.json packages/envelope/
COPY services/core/package.json services/core/
RUN pnpm install --filter onclave-core --frozen-lockfile

COPY packages/envelope/src packages/envelope/src
COPY services/core/src services/core/src

WORKDIR /app/services/core
VOLUME /data
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/main.ts"]
