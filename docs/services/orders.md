# Orders service (Python / FastAPI)

## Role
Creates orders, calls catalog + third parties, persists to Postgres, publishes `orders.created`.

## Flow
1. Resolve OpenFeature chaos gates
2. Optional latency / catalog failure
3. Fetch product from catalog
4. Call Open-Meteo (weather enrichment)
5. Optional Stripe PaymentIntent
6. Insert row (`pending`)
7. Publish RabbitMQ message (or fail_publish → `failed`)
8. Optional slow_close delay

## Telemetry
- FastAPI / httpx / psycopg instrumentation
- Manual spans for third parties with `peer.service`
- Attributes: `order.id`, `chaos.*`, `feature_flag.source`

## Key files
- `main.py` — API + orchestration
- `feature_flags.py` — OpenFeature/flagd
- `telemetry.py` — OTLP providers
- `schema.py` — additive migrations
