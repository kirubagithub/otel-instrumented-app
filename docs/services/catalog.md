# Catalog service (Java / Spring Boot)

## Role
Read-only product catalog backed by Postgres.

## Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| GET | `/products` | List products |
| GET | `/products/{id}` | Product detail (`price_cents`) |

## Telemetry
- OpenTelemetry Java agent (`opentelemetry-javaagent.jar`)
- Auto HTTP + JDBC spans

## Key files
- `CatalogController.java` — REST handlers
- `application.properties` — datasource
- `Dockerfile` — builds jar + attaches Java agent
