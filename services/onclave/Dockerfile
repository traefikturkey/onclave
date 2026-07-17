FROM golang:1.26-alpine AS build
WORKDIR /src
COPY services/onclave/go.mod services/onclave/go.sum* ./services/onclave/
COPY services/onclave ./services/onclave
WORKDIR /src/services/onclave
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/onclave ./cmd/onclave

FROM alpine:3.22
RUN addgroup -S onclave && adduser -S -G onclave onclave
WORKDIR /app
COPY --from=build /out/onclave /app/onclave
RUN mkdir -p /data/onclave && chown -R onclave:onclave /data/onclave
USER onclave
EXPOSE 8080
ENTRYPOINT ["/app/onclave"]
