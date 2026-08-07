# Architecture

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

Services **only** talk OTLP to the Collector. Swap backends with `OTEL_BACKEND_*` (see `otel-collector/config.yaml`).

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
- Always writes `processing` → `processed` / `failed`
- Uses a local fallback ref if JSONPlaceholder is unreachable (span still records ERROR)
- Exposes `:8083/health`
