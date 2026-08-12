# OTel Microservices Lab

Polyglot microservices demo instrumented with **OpenTelemetry** (RUM, traces, logs, metrics). Apps export OTLP to a **Collector**; the default backend is OpenObserve but is swappable via env.

## Quick start

```bash
cp .env.example .env
# set OTEL_BACKEND_OTLP_HTTP_ENDPOINT + OTEL_BACKEND_AUTHORIZATION
docker compose up --build
```

- UI (multi-page RUM): http://localhost:5173  
- Locust journeys: `docker compose --profile loadgen up --build locust` → http://localhost:8089  
- Worker health: http://localhost:8083/health  

## Pages (RUM)

| Route | Why it exists |
|-------|----------------|
| `/login` | User session spans |
| `/catalog` | Browse interactions |
| `/checkout` | Order create |
| `/orders` | Status polling / table |
| `/gates` | OpenFeature chaos on/off UI |
| `/account` | Extra route for page metrics |

## Automation: Locust vs Playwright

**Prefer Locust** for volume and intermittent backend faults (many concurrent login→checkout→poll flows). It hits the BFF API and can randomly apply chaos gates.

**Use Playwright** (`scripts/playwright-journey.mjs`) when you need **real browser RUM** across SPA routes.

See `loadgen/README.md` and `docs/chaos-and-feature-flags.md`.

## Docs

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Chaos / OpenFeature](docs/chaos-and-feature-flags.md)
- Services: [frontend](docs/services/frontend.md) · [bff](docs/services/bff.md) · [orders](docs/services/orders.md) · [catalog](docs/services/catalog.md) · [worker](docs/services/worker.md)

## Pluggable backends

Apps → Collector only (shared OTLP/HTTP). Configure `OTEL_BACKEND_*` for OpenObserve, another product, or a **second Collector on the host**.

If another Compose stack already owns host `:4318`, remap this lab’s published ports and use `http://host.docker.internal:4318` — see [Telemetry wiring](docs/telemetry.md).
