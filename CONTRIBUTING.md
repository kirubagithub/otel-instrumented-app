# Contributing to OTel Lab

Thanks for helping improve this observability demo stack.

## Principles

1. **Apps export only to the Collector** (OTLP). Never hard-code a vendor SDK exporter in services.
2. **Chaos belongs in OpenFeature/flagd**, not scattered `if` flags without a control plane.
3. Prefer small, documented changes with a clear telemetry story (what new spans/attributes appear).

## Repo map

| Path | Purpose |
|------|---------|
| `frontend/` | React SPA + RUM |
| `services/bff` | Node gateway |
| `services/orders` | Python order orchestration |
| `services/catalog` | Java product API |
| `services/worker` | Go queue consumer |
| `otel-collector/` | Pipeline + backend exporters |
| `flags/` | OpenFeature flagd definitions |
| `loadgen/` | Locust journeys |
| `docs/` | Architecture + per-service docs |

## Dev loop

```bash
cp .env.example .env   # set OTEL_BACKEND_* 
docker compose up --build
# optional load:
docker compose --profile loadgen up --build locust
```

UI: http://localhost:5173 · Locust: http://localhost:8089 · Worker health: http://localhost:8083/health

## Adding a service

1. Emit OTLP/HTTP to the local collector (`OTEL_EXPORTER_OTLP_ENDPOINT`, shared via Compose `x-otel-env`).
2. Propagate `traceparent` on HTTP and messaging.
3. Tag third-party CLIENT spans with `peer.service` / `dependency.type=third_party`.
4. Document the service under `docs/services/`.
5. Wire it in `docker-compose.yml` using `<<: *otel-env`.

## Adding a chaos gate

1. Add the flag to `flags/chaos.flagd.json`.
2. Evaluate it in the affected service via OpenFeature.
3. Expose it on the **Gates** UI (`PUT /api/flags/chaos` already merges known keys — extend BFF `featureFlags.js` lists).
4. Document the flag in `docs/chaos-and-feature-flags.md`.

## Pull requests

- Keep PRs focused (one feature or fix).
- Update docs when behavior or env vars change.
- Note how to verify in OpenObserve (or your backend): service names, attributes, example queries.

## Code of collaboration

Be kind, prefer clarity over cleverness, and treat this repo as a teaching lab: every failure mode should be explainable from a trace.
