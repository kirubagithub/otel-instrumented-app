# Telemetry wiring

## Two layers (do not mix them)

```
Apps + browser RUM
        │  OTLP/HTTP (shared env)
        ▼
Local OpenTelemetry Collector
        │  OTEL_BACKEND_* env
        ▼
OpenObserve / Grafana / Honeycomb / …
```

| Layer | What you configure | Default |
|-------|--------------------|---------|
| **Ingest** (apps → collector) | `OTEL_COLLECTOR_HOST`, host ports | HTTP → `otel-collector:4318` |
| **Backend** (collector → product) | `OTEL_BACKEND_OTLP_HTTP_ENDPOINT`, `OTEL_BACKEND_AUTHORIZATION` | OpenObserve |

## Easy run

```bash
cp .env.example .env
# set OTEL_BACKEND_AUTHORIZATION (+ endpoint if needed)
docker compose up --build
```

All services share one OTLP/HTTP endpoint via Compose (`x-otel-env`). You do not set per-service ports.

## If host ports 4317/4318 are busy

In `.env`:

```bash
OTEL_COLLECTOR_HTTP_PORT=14318
OTEL_COLLECTOR_GRPC_PORT=14317
```

Internal Docker ports stay `4317`/`4318`. Apps still talk to `http://otel-collector:4318` on the Compose network.

## Browser RUM

Uses same-origin `/otlp` (nginx → collector HTTP). Leave `VITE_OTEL_EXPORTER_OTLP_ENDPOINT=/otlp`.

## Protocol

This lab uses **HTTP (`http/protobuf`) for every service**. gRPC receiver on the collector remains available for tools/debugging, but apps do not use it.
