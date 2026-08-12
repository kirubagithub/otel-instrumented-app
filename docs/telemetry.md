# Telemetry wiring

## Two layers (do not mix them)

```
Apps + browser RUM
        │  OTLP/HTTP (shared env)
        ▼
Local OpenTelemetry Collector  (this Compose stack)
        │  OTEL_BACKEND_* env
        ▼
Your backend (OpenObserve, Grafana, or another Collector on the host)
```

| Layer | What you configure | Default |
|-------|--------------------|---------|
| **Ingest** (apps → collector) | `OTEL_COLLECTOR_HOST`, host ports | HTTP → `otel-collector:4318` |
| **Backend** (collector → product) | `OTEL_BACKEND_OTLP_HTTP_ENDPOINT`, optional auth headers | OpenObserve-shaped URL |

## Easy run

```bash
cp .env.example .env
# edit OTEL_BACKEND_* for your sink
docker compose up --build
```

All services share one OTLP/HTTP endpoint via Compose (`x-otel-env`). You do not set per-service ports.

## Export to another Collector on localhost (separate Compose)

Your other stack (e.g. `xd-oss-stack`) already binds **host** `0.0.0.0:4318→4318`.  
This lab also publishes `:4318` by default — **only one process can own that host port**.

In `.env`:

```bash
# Free host :4318 for the other stack; keep internal :4318 for apps
OTEL_COLLECTOR_HTTP_PORT=14318
OTEL_COLLECTOR_GRPC_PORT=14317

# Lab collector → host → your other collector
OTEL_BACKEND_OTLP_HTTP_ENDPOINT=http://host.docker.internal:4318
OTEL_BACKEND_AUTHORIZATION=
OTEL_BACKEND_HEADER_ORGANIZATION=
OTEL_BACKEND_HEADER_STREAM=
```

Then:

```bash
docker compose up -d --force-recreate otel-collector
```

`otel-collector` has `extra_hosts: host.docker.internal:host-gateway` so this works on **Linux and WSL2**, not only Docker Desktop Mac/Windows.

### If you still see `context deadline exceeded`

1. Confirm the other collector is reachable on the host:
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4318/v1/traces \
     -H 'Content-Type: application/json' --data '{}'
   ```
   Any HTTP response (even 400) means the port is open; hang/timeout means it is not.

2. Confirm this lab is **not** also bound to host 4318:
   ```bash
   docker compose ps otel-collector
   # PORTS should show 14318->4318, not 4318->4318
   ```

3. Fallback endpoint (docker0 bridge):
   ```bash
   OTEL_BACKEND_OTLP_HTTP_ENDPOINT=http://172.17.0.1:4318
   ```

4. Do **not** leave `OTEL_BACKEND_AUTHORIZATION=Basic REPLACE_ME` when talking to a plain Collector — clear it.

### Alternative: shared Docker network

If both Compose projects run on the same Docker engine, you can attach this lab’s collector to the other project’s network and use that container’s name/IP instead of `host.docker.internal`. Avoid two containers both named `otel-collector` on one network without an alias.

## If host ports 4317/4318 are busy (any reason)

```bash
OTEL_COLLECTOR_HTTP_PORT=14318
OTEL_COLLECTOR_GRPC_PORT=14317
```

Internal Docker ports stay `4317`/`4318`. Apps still talk to `http://otel-collector:4318` on the Compose network.

The collector image has no `wget`/`curl`, so Compose does **not** use a Docker healthcheck for it (that was marking it `unhealthy` even when ready). Dependents use `service_started`; OTLP clients retry if needed.

## Browser RUM

Uses same-origin `/otlp` (nginx → collector HTTP). Leave `VITE_OTEL_EXPORTER_OTLP_ENDPOINT=/otlp`.

## Protocol

This lab uses **HTTP (`http/protobuf`) for every service**. gRPC receiver on the collector remains available for tools/debugging, but apps do not use it. Your other stack only publishes **4318/tcp** to the host — use OTLP/HTTP for the backend exporter (not gRPC/`4317`).
