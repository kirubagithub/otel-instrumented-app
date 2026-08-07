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
- `CHAOS_INTERMITTENT=true` — ~25% of users apply a random chaos gate burst via OpenFeature

## Run locally

```bash
pip install -r requirements.txt
locust -f locustfile.py --host http://localhost:3000
```
