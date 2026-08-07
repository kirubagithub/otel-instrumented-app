# OTel Microservices Lab

Docker Compose demo of a polyglot microservice stack instrumented with **OpenTelemetry** (RUM, traces, logs, metrics).

## Design: pluggable backends (recommended)

**Apps never talk to OpenObserve / Grafana / Honeycomb directly.**

```
Browser + services  ──OTLP──►  OpenTelemetry Collector  ──OTLP/HTTP or OTLP/gRPC──►  your backend
```

To switch backends later, change **Collector env / config only** — not application code.

| Env var | Purpose |
|---------|---------|
| `OTEL_BACKEND_OTLP_HTTP_ENDPOINT` | Default exporter endpoint (OpenObserve today) |
| `OTEL_BACKEND_AUTHORIZATION` | `Authorization` header |
| `OTEL_BACKEND_HEADER_ORGANIZATION` | Optional (OpenObserve) |
| `OTEL_BACKEND_HEADER_STREAM` | Optional (OpenObserve) |

In `otel-collector/config.yaml`:
- **Active:** `otlphttp/backend` (OTLP/HTTP)
- **Commented:** `otlp/backend` (OTLP/gRPC) — uncomment exporter + swap pipeline exporters when you need gRPC

## Architecture

```
Browser (React RUM) ──/otlp──► nginx ──► collector ──► backend (OpenObserve by default)
   │
   ▼
BFF (Node) ──OpenFeature──► flagd
Orders (Python) ──OpenFeature──► flagd
Worker (Go) ──OpenFeature──► flagd
   │
   ├─ Catalog (Java) → Postgres
   ├─ Open-Meteo / Stripe
   └─ RabbitMQ → Worker → JSONPlaceholder
```

## Quick start

```bash
cp .env.example .env
# set OTEL_BACKEND_OTLP_HTTP_ENDPOINT + OTEL_BACKEND_AUTHORIZATION
docker compose up --build
```

UI: http://localhost:5173

## OpenFeature chaos gates

Error / latency scenarios are **feature flags**, not hard-coded in the request path.

- Flag definitions: `flags/chaos.flagd.json`
- Runtime control plane: **flagd** (hot-reloads the file)
- UI **Apply feature gates** → `PUT /api/flags/chaos` → writes the flag file
- Or edit the file / call the API from outside the app

Services evaluate flags on each request/consume via OpenFeature. Spans include `feature_flag.source=openfeature/flagd` and `chaos.*`.

```bash
# Example: enable Open-Meteo failures from outside
curl -X PUT http://localhost:3000/api/flags/chaos \
  -H 'content-type: application/json' \
  -d '{"chaos":{"fail_open_meteo":true,"orders_latency_ms":1500}}'
```

## Orders table

- Loaded from Postgres, auto-refresh every 2s
- Status: `pending` → `processing` → `processed` / `failed`
- **Clear all** wipes demo rows

## RUM

Browser exports to same-origin `/otlp` (nginx → collector). Filter OpenObserve (or any backend) by `service.name="frontend-rum"` or `session.id`.

## Local ports

| Service | Port |
|---------|------|
| UI | 5173 |
| BFF | 3000 |
| Orders | 8081 |
| Catalog | 8082 |
| flagd gRPC / OFREP | 8013 / 8014 |
| Collector OTLP | 4317 / 4318 |
| RabbitMQ UI | 15672 (`otel`/`otel`) |
