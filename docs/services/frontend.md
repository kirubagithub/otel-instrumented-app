# Frontend (React + RUM)

## Role
Multi-page SPA that drives Real User Monitoring and human demos.

## Routes
| Path | Purpose |
|------|---------|
| `/` | Landing |
| `/login` | Demo session |
| `/catalog` | Product grid |
| `/checkout` | Create order |
| `/orders` | Postgres-backed order table |
| `/gates` | OpenFeature chaos control plane |
| `/account` | Session summary page |

## Telemetry
- `@opentelemetry/sdk-trace-web` + fetch / document-load / user-interaction
- Exports to same-origin `/otlp` (nginx → collector)
- Resource: `service.name=frontend-rum`, `session.id`

## Key files
- `src/otel.js` — RUM bootstrap
- `src/pages/*` — route pages
- `nginx.conf` — SPA fallback + OTLP proxy
