# OTel Microservices Lab

Docker Compose demo of a polyglot microservice stack instrumented with **OpenTelemetry** (RUM, traces, logs, metrics). All apps export OTLP to an **OpenTelemetry Collector**, which forwards telemetry to **OpenObserve**.

## Architecture

```
Browser (React RUM)
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

All services + browser ──OTLP──► otel-collector ──OTLP/HTTP──► OpenObserve
```

| Service | Language | Port | Role |
|---------|----------|------|------|
| `frontend` | React (Vite) | 5173 | RUM / UI |
| `bff` | Node.js | 3000 | API gateway |
| `orders` | Python | 8081 | Orders + third-party calls |
| `catalog` | Java | 8082 | Product catalog + DB |
| `worker` | Go | — | Async consumer + third-party call |
| `postgres` | — | 5432 | Shared DB |
| `rabbitmq` | — | 5672 / 15672 | Message broker |
| `otel-collector` | — | 4317 / 4318 | OTLP ingest → OpenObserve |

## Quick start

1. Copy env and set OpenObserve credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
OPENOBSERVE_OTLP_ENDPOINT=https://api.openobserve.ai/api/<your-org>
OPENOBSERVE_AUTHORIZATION=Basic <your-token>
OPENOBSERVE_ORG=<your-org>
OPENOBSERVE_STREAM=default
# optional
STRIPE_SECRET_KEY=sk_test_...
```

> OpenObserve OTLP base URL is typically `https://api.openobserve.ai/api/<org>` (self-hosted: `http://<host>:5080/api/<org>`). The collector appends `/v1/traces`, `/v1/logs`, `/v1/metrics`.

2. Start the stack:

```bash
docker compose up --build
```

3. Open the UI: [http://localhost:5173](http://localhost:5173)

4. Click **Create traced order**, then in OpenObserve search traces by:
   - `order.id`
   - `dependency.type = "third_party"`
   - `peer.service` in (`open-meteo`, `stripe`, `jsonplaceholder`)

## What you see for third-party APIs

OpenTelemetry does **not** instrument Stripe/Open-Meteo internals. It shows the **client edge** from your services:

| Attribute / signal | Meaning |
|--------------------|---------|
| Span kind `CLIENT` | Outbound call from your service |
| `peer.service` | Logical dependency name (collector + app enrichment) |
| `dependency.type=third_party` | Filter external calls in OpenObserve |
| `http.response.status_code`, duration | Outcome + latency from your side |
| `stripe.payment_intent_id`, `stripe.request_id` | Correlate to Stripe Dashboard |
| `weather.temperature_c`, `jsonplaceholder.post_id` | Safe business/result fields |
| Linked `trace_id` on logs | Jump from span → log line |

## Local endpoints

- UI: http://localhost:5173
- BFF health: http://localhost:3000/health
- Orders: http://localhost:8081/health
- Catalog: http://localhost:8082/health
- RabbitMQ UI: http://localhost:15672 (otel / otel)
- Collector health: http://localhost:13133

## Demo flow (one trace)

1. Browser RUM span on click + instrumented `fetch` to BFF  
2. BFF → catalog / orders (propagated context)  
3. Orders reads product, writes Postgres, calls **Open-Meteo**, optionally **Stripe**, publishes RabbitMQ  
4. Worker consumes message (links via `traceparent` in AMQP headers), calls **JSONPlaceholder**, updates order status  

## Notes

- Without `STRIPE_SECRET_KEY`, Stripe spans are skipped; Open-Meteo + JSONPlaceholder always run.
- Collector also logs a sampled `debug` exporter to container logs — useful before OpenObserve auth is valid.
- Set browser OTLP URL with `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) so RUM reaches the collector from the host browser.
