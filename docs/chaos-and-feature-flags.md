# Chaos and OpenFeature

Feature gates live in `flags/chaos.flagd.json` and are served by **flagd**.

## Control plane

| Method | How |
|--------|-----|
| UI | `/gates` → Apply gates |
| API | `PUT http://localhost:3000/api/flags/chaos` with `{ "chaos": { ... } }` |
| File | Edit `flags/chaos.flagd.json` (flagd hot-reloads) |

## Flags

| Key | Type | Effect |
|-----|------|--------|
| `chaos.bff_latency_ms` | int | Delay in BFF before proxying |
| `chaos.catalog_latency_ms` | int | Delay before catalog call |
| `chaos.orders_latency_ms` | int | Delay inside orders service |
| `chaos.worker_latency_ms` | int | Delay in worker processing |
| `chaos.queue_lag_ms` | int | Artificial consumer lag |
| `chaos.slow_close_ms` | int | Delay before HTTP response returns |
| `chaos.fail_open_meteo` | bool | Inject Open-Meteo failure |
| `chaos.fail_stripe` | bool | Inject Stripe failure (**works without `STRIPE_SECRET_KEY`**) |
| `chaos.fail_jsonplaceholder` | bool | Inject worker third-party failure |
| `chaos.fail_catalog` | bool | Break catalog hop |
| `chaos.fail_publish` | bool | Skip RabbitMQ publish; mark order failed |

Spans include `feature_flag.source=openfeature/flagd` and `chaos.*` attributes.

## Locust intermittent chaos

With `CHAOS_INTERMITTENT=true`, ~25% of Locust users apply a random chaos profile before shopping — good for catching intermittent backend issues in OpenObserve.
