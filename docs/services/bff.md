# BFF service (Node.js)

**BFF = Backend For Frontend** — an API tailored for the browser SPA. See [Application workflow](../application-workflow.md#what-is-the-bff) for why it exists and how it fits the map.

## Role
API gateway between the browser and internal services. Owns demo session + flag admin writes. The frontend never calls orders or catalog directly.

## Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| POST | `/api/session/login` | Demo login (span attrs `user.id`) |
| POST | `/api/session/logout` | Demo logout |
| GET/PUT | `/api/flags/chaos` | Read/update OpenFeature gates (writes flag file) |
| GET | `/api/products` | Proxy → catalog |
| GET/POST/DELETE | `/api/orders` | Proxy → orders |
| GET | `/api/orders/:id` | Proxy → orders |

## Telemetry
- Auto-instrumentation via `src/tracing.js`
- Manual spans for gateway operations
- Evaluates `chaos.bff_latency_ms` before create-order

## Key files
- `src/index.js` — HTTP routes
- `src/featureFlags.js` — OpenFeature client + flag file writer
- `src/tracing.js` — OTLP SDK setup
