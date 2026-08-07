# Worker service (Go)

## Role
Consumes `orders.created` from RabbitMQ, calls JSONPlaceholder, updates order status in Postgres.

## Status machine
`pending` → `processing` → `processed` (with `external_ref`) or `failed` (with `error_message`)

## Reliability notes
- OpenFeature registration is **non-blocking** so consumption always starts
- RabbitMQ reconnect loop
- If JSONPlaceholder is unreachable, writes a `local-fallback-*` ref and still marks `processed` (CLIENT span remains ERROR) so demos are not stuck
- Chaos `fail_jsonplaceholder` forces a true `failed` status
- Health: `GET :8083/health`

## Telemetry
- Consumer span `worker.consume_order_created`
- CLIENT span `worker.call_jsonplaceholder`
- Propagates `traceparent` from AMQP headers

## Key files
- `main.go` — consumer, flags, OTLP, health
