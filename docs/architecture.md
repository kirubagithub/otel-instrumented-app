# Architecture

High-level stack. For **request flows, BFF explanation, and service-map guidance**, see [application-workflow.md](./application-workflow.md).

```
Browser SPA (RUM)
  routes: / /login /catalog /checkout /orders /gates /account
  OTLP → nginx /otlp → Collector → backend (OpenObserve by default)

BFF (Node)
  session + flags admin + API proxy

Orders (Python) → Catalog (Java) → Postgres
                → Open-Meteo / Stripe
                → RabbitMQ → Worker (Go) → JSONPlaceholder → Postgres

flagd ← OpenFeature clients in BFF / orders / worker
Locust (optional) → BFF HTTP journeys
```

## Telemetry rule

Services **only** talk OTLP/HTTP to the local Collector (`OTEL_EXPORTER_OTLP_ENDPOINT`).  
Swap backends with `OTEL_BACKEND_*` (see `otel-collector/config.yaml` and [telemetry.md](./telemetry.md)).

## User journey (manual or Locust)

1. Login (demo session)
2. Catalog browse
3. Checkout / create order
4. Orders table polls until `processed` or `failed`
5. Optional: Gates page toggles chaos for intermittent faults

## Why orders were stuck on `pending`

The worker previously could block on OpenFeature `SetProviderAndWait` / flaky third-party calls and never complete the message. It now:

- Registers flagd **non-blocking**
- Reconnects to RabbitMQ
- Writes `processing` early (before `chaos.queue_lag_ms` sleep) → `processed` / `failed`
- Uses a local fallback ref if JSONPlaceholder is unreachable (span still records ERROR)
- Exposes `:8083/health`

If Locust shows orders “stuck” with **0% fails**, check that chaos flags are not sticky
(`queue_lag_ms` / worker latency serialize the consumer). Current Locust resets a **full**
flag snapshot and fails journeys that never reach `processed`/`failed`.
