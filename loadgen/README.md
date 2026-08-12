# Locust load / journey generator for API-side telemetry

## Why Locust (vs Playwright)?

| Tool | Best for | RUM? |
|------|----------|------|
| **Locust** | Many concurrent users, random checkout flows, intermittent chaos | No (API only) |
| **Playwright** | Real browser page views, clicks, SPA route changes | Yes |

Use **Locust** to flood the backend with realistic journeys (login → catalog → order → poll).
Use **Playwright** (optional, see `../scripts/playwright-journey.mjs`) when you need RUM page metrics.

## Run with Compose

```bash
docker compose --profile loadgen up --build locust
```

Open http://localhost:8089 — start with e.g. 5 users, spawn rate 1, host `http://bff:3000` (pre-set).

Env:
- `CHAOS_INTERMITTENT=true` — ~25% of users apply a **full** chaos flag snapshot (defaults ⊕ burst) via OpenFeature so gates never stick from a prior burst
- `ORDER_POLL_SECONDS=45` — fail the journey if an order stays non-terminal (`pending`/`processing`) this long

Locust counts these as failures (visible in the report):
- HTTP 4xx/5xx on checkout (including Gates like `fail_stripe` / `fail_catalog`)
- Order still `pending`/`processing` after the poll window (worker/queue problem)

Tip: leave Gates on **off** before a baseline run, or set `CHAOS_INTERMITTENT=false`.

## Run locally

```bash
pip install -r requirements.txt
locust -f locustfile.py --host http://localhost:3000
```
