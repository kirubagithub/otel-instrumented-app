# OTel Microservices Lab

Docker Compose demo of a polyglot microservice stack instrumented with **OpenTelemetry** (RUM, traces, logs, metrics). All apps export OTLP to an **OpenTelemetry Collector**, which forwards telemetry to **OpenObserve**.

## Architecture

```
Browser (React RUM) ──/otlp──► nginx proxy ──► otel-collector ──► OpenObserve
   │  fetch + traceparent
   ▼
BFF (Node.js / Express)
   ├──────────────► Catalog (Java / Spring) ──► PostgreSQL
   └──────────────► Orders (Python / FastAPI)
                        ├─► Catalog
                        ├─► PostgreSQL
                        ├─► Open-Meteo (third-party HTTP)     ← CLIENT spans
                        ├─► Stripe test API (optional)        ← CLIENT spans
                        └─► RabbitMQ ──► Worker (Go)
                                            ├─► JSONPlaceholder (third-party)
                                            └─► PostgreSQL
```

| Service | Language | Port | Role |
|---------|----------|------|------|
| `frontend` | React (Vite) | 5173 | RUM / UI / orders table / chaos controls |
| `bff` | Node.js | 3000 | API gateway |
| `orders` | Python | 8081 | Orders + third-party calls |
| `catalog` | Java | 8082 | Product catalog + DB |
| `worker` | Go | — | Async consumer + third-party call |
| `postgres` | — | 5432 | Shared DB |
| `rabbitmq` | — | 5672 / 15672 | Message broker |
| `otel-collector` | — | 4317 / 4318 | OTLP ingest → OpenObserve |

## Quick start

```bash
cp .env.example .env
# set OPENOBSERVE_* (+ optional STRIPE_SECRET_KEY)
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173).

### Orders table
- All orders are loaded from Postgres and auto-refresh every 2s.
- Status moves `pending` → `processing` → `processed` (or `failed`).
- **Clear all** deletes rows from the demo DB so test data does not pile up.

### Chaos / fault injection
From the UI (or `POST /api/orders` body `chaos`):

| Knob | Effect | What to look for in OpenObserve |
|------|--------|----------------------------------|
| `*_latency_ms` | Sleep in BFF / catalog path / orders / worker | Longer spans, `chaos.delay.*` |
| `queue_lag_ms` | Delay before worker processes message | Gap between publish and consume |
| `slow_close_ms` | Delay before orders HTTP response returns | Long SERVER span on create |
| `fail_open_meteo` / `fail_stripe` / `fail_jsonplaceholder` | Injected third-party errors | ERROR CLIENT spans, `chaos.fail_*` |
| `fail_catalog` / `fail_publish` | Break internal hop or queue publish | 503/failed order, error attributes |

## RUM

Browser traces export to **same-origin** `http://localhost:5173/otlp/v1/traces` (nginx → collector). This avoids CORS and “localhost:4318 blocked” issues.

In OpenObserve filter `service.name = "frontend-rum"` or `session.id` shown in the UI header.

## Third-party visibility

OTel does **not** instrument Stripe/Open-Meteo internals. You get **client-edge** data:

- Span kind `CLIENT`, duration, status
- `peer.service`, `dependency.type=third_party`
- Enrichment: `stripe.payment_intent_id`, `stripe.request_id`, `weather.temperature_c`, `jsonplaceholder.post_id`

## Local endpoints

- UI: http://localhost:5173
- BFF: http://localhost:3000/health
- Orders list: http://localhost:8081/orders
- RabbitMQ UI: http://localhost:15672 (`otel` / `otel`)
- Collector health: http://localhost:13133
