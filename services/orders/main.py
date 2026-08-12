import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, Optional

import httpx
import pika
import psycopg
import stripe
from fastapi import FastAPI, HTTPException
from opentelemetry import trace
from opentelemetry.propagate import inject
from opentelemetry.trace import Status, StatusCode
from pydantic import BaseModel, Field

from schema import ensure_schema
from telemetry import setup_telemetry
from feature_flags import init_feature_flags, resolve_chaos

logger = logging.getLogger("orders-service")
app = FastAPI(title="orders-service")
tracer = setup_telemetry(app)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://otel:otel@localhost:5432/otel_demo")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://otel:otel@localhost:5672/")
CATALOG_URL = os.getenv("CATALOG_URL", "http://localhost:8082").rstrip("/")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY

ORDER_COLUMNS = [
    "id",
    "product_id",
    "quantity",
    "status",
    "weather_temp_c",
    "exchange_rate",
    "stripe_payment_intent_id",
    "stripe_request_id",
    "external_ref",
    "error_message",
    "chaos_flags",
    "created_at",
    "updated_at",
]


class ChaosOptions(BaseModel):
    """Fault injection knobs — all optional, safe defaults."""

    bff_latency_ms: int = Field(0, ge=0, le=30000)
    catalog_latency_ms: int = Field(0, ge=0, le=30000)
    orders_latency_ms: int = Field(0, ge=0, le=30000)
    worker_latency_ms: int = Field(0, ge=0, le=30000)
    queue_lag_ms: int = Field(0, ge=0, le=60000)
    slow_close_ms: int = Field(0, ge=0, le=30000)
    fail_open_meteo: bool = False
    fail_stripe: bool = False
    fail_jsonplaceholder: bool = False
    fail_catalog: bool = False
    fail_publish: bool = False


class CreateOrderRequest(BaseModel):
    product_id: int
    quantity: int = Field(ge=1, le=100)
    latitude: float = 40.71
    longitude: float = -74.01
    # Optional one-shot overrides. Prefer OpenFeature/flagd gates for normal demos.
    chaos: Optional[ChaosOptions] = None


def get_conn():
    return psycopg.connect(DATABASE_URL)


def row_to_order(row) -> dict[str, Any]:
    out = {}
    for k, v in zip(ORDER_COLUMNS, row):
        if hasattr(v, "isoformat") or isinstance(v, uuid.UUID):
            out[k] = str(v)
        else:
            out[k] = v
    return out


async def apply_delay(ms: int, name: str) -> None:
    if ms <= 0:
        return
    with tracer.start_as_current_span(f"chaos.delay.{name}") as span:
        span.set_attribute("chaos.latency_ms", ms)
        span.set_attribute("chaos.layer", name)
        await asyncio.sleep(ms / 1000.0)


def publish_order_created(payload: dict[str, Any]) -> None:
    with tracer.start_as_current_span("orders.publish_order_created") as span:
        span.set_attribute("messaging.system", "rabbitmq")
        span.set_attribute("messaging.destination.name", "orders.created")
        span.set_attribute("order.id", payload.get("id", ""))

        headers: dict[str, Any] = {}
        inject(headers)
        # RabbitMQ requires AMQP-native header values (strings)
        amqp_headers = {str(k): str(v) for k, v in headers.items() if v is not None}

        params = pika.URLParameters(RABBITMQ_URL)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue="orders.created", durable=True)
        channel.basic_publish(
            exchange="",
            routing_key="orders.created",
            body=json.dumps(payload).encode("utf-8"),
            properties=pika.BasicProperties(
                delivery_mode=2,
                content_type="application/json",
                headers=amqp_headers,
            ),
        )
        connection.close()


async def fetch_product(product_id: int, chaos: ChaosOptions) -> dict[str, Any]:
    await apply_delay(chaos.catalog_latency_ms, "catalog")
    if chaos.fail_catalog:
        with tracer.start_as_current_span("orders.call_catalog") as span:
            span.set_attribute("chaos.fail_catalog", True)
            span.set_status(Status(StatusCode.ERROR, "chaos fail_catalog"))
            raise HTTPException(status_code=503, detail="chaos_catalog_failure")

    headers: dict[str, str] = {}
    inject(headers)
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{CATALOG_URL}/products/{product_id}", headers=headers)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="product_not_found")
        resp.raise_for_status()
        return resp.json()


async def fetch_weather(lat: float, lon: float, chaos: ChaosOptions) -> Optional[float]:
    """Call Open-Meteo — creates an HTTP CLIENT span to a third-party API."""
    with tracer.start_as_current_span("orders.call_open_meteo") as span:
        span.set_attribute("peer.service", "open-meteo")
        span.set_attribute("dependency.type", "third_party")
        span.set_attribute("geo.lat", lat)
        span.set_attribute("geo.lon", lon)
        if chaos.fail_open_meteo:
            span.set_attribute("chaos.fail_open_meteo", True)
            span.set_status(Status(StatusCode.ERROR, "chaos fail_open_meteo"))
            span.add_event("third_party.error", {"reason": "injected_failure"})
            logger.warning("chaos: simulating open-meteo failure")
            return None

        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}&current=temperature_2m"
        )
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url)
                span.set_attribute("http.response.status_code", resp.status_code)
                resp.raise_for_status()
                data = resp.json()
                temp = data.get("current", {}).get("temperature_2m")
                if temp is not None:
                    span.set_attribute("weather.temperature_c", float(temp))
                return float(temp) if temp is not None else None
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            logger.warning("open-meteo call failed: %s", exc)
            return None


async def create_stripe_intent(
    amount_cents: int, currency: str, order_id: str, chaos: ChaosOptions
) -> tuple[Optional[str], Optional[str]]:
    # Always honor fail_stripe — even when no Stripe key is configured — so Gates /
    # Locust demos produce a real 502 without requiring STRIPE_SECRET_KEY.
    if chaos.fail_stripe:
        with tracer.start_as_current_span("orders.call_stripe_payment_intent") as span:
            span.set_attribute("peer.service", "stripe")
            span.set_attribute("dependency.type", "third_party")
            span.set_attribute("order.id", order_id)
            span.set_attribute("payment.amount_cents", amount_cents)
            span.set_attribute("payment.currency", currency)
            span.set_attribute("chaos.fail_stripe", True)
            span.set_attribute("stripe.mode", "chaos_injected")
            span.set_status(Status(StatusCode.ERROR, "chaos fail_stripe"))
            raise HTTPException(status_code=502, detail="chaos_stripe_failure")

    if not STRIPE_SECRET_KEY:
        return None, None

    with tracer.start_as_current_span("orders.call_stripe_payment_intent") as span:
        span.set_attribute("peer.service", "stripe")
        span.set_attribute("dependency.type", "third_party")
        span.set_attribute("order.id", order_id)
        span.set_attribute("payment.amount_cents", amount_cents)
        span.set_attribute("payment.currency", currency)

        try:
            intent = stripe.PaymentIntent.create(
                amount=amount_cents,
                currency=currency,
                metadata={"order_id": order_id},
                automatic_payment_methods={"enabled": True},
            )
            request_id = getattr(getattr(intent, "last_response", None), "request_id", None)
            span.set_attribute("stripe.payment_intent_id", intent.id)
            span.set_attribute("stripe.payment_status", intent.status)
            if request_id:
                span.set_attribute("stripe.request_id", request_id)
            return intent.id, request_id
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            logger.exception("stripe PaymentIntent failed")
            raise HTTPException(status_code=502, detail=f"stripe_error: {exc}") from exc


@app.on_event("startup")
def on_startup():
    ensure_schema(DATABASE_URL)
    init_feature_flags()


@app.get("/chaos")
def get_chaos_flags():
    """Current chaos feature-gate values from OpenFeature/flagd."""
    return {"source": "openfeature/flagd", "chaos": resolve_chaos("orders-service")}


@app.get("/health")
def health():
    return {"status": "ok", "service": "orders-service"}


@app.get("/orders")
def list_orders(limit: int = 50):
    limit = max(1, min(limit, 200))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {", ".join(ORDER_COLUMNS)}
                FROM orders
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (limit,),
            )
            return [row_to_order(row) for row in cur.fetchall()]


@app.delete("/orders")
def clear_orders():
    with tracer.start_as_current_span("orders.clear_all") as span:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM orders")
                deleted = cur.rowcount
            conn.commit()
        span.set_attribute("orders.deleted", deleted)
        logger.info("cleared %s orders", deleted)
        return {"deleted": deleted}


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT {", ".join(ORDER_COLUMNS)}
                FROM orders WHERE id = %s
                """,
                (order_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="order_not_found")
            return row_to_order(row)


@app.post("/orders")
async def create_order(body: CreateOrderRequest):
    # OpenFeature gates are the control plane; request.chaos is an optional override.
    flag_chaos = resolve_chaos(targeting_key=str(body.product_id))
    if body.chaos is not None:
        override = body.chaos.model_dump()
        for key, value in override.items():
            if isinstance(value, bool):
                flag_chaos[key] = flag_chaos.get(key, False) or value
            elif isinstance(value, (int, float)) and value:
                flag_chaos[key] = int(value)
    chaos = ChaosOptions(**flag_chaos)
    started = time.perf_counter()

    with tracer.start_as_current_span("orders.create_order") as span:
        span.set_attribute("order.product_id", body.product_id)
        span.set_attribute("order.quantity", body.quantity)
        span.set_attribute("feature_flag.source", "openfeature/flagd")
        span.set_attribute("chaos.enabled", any(
            [
                chaos.orders_latency_ms,
                chaos.queue_lag_ms,
                chaos.slow_close_ms,
                chaos.fail_open_meteo,
                chaos.fail_stripe,
                chaos.fail_jsonplaceholder,
                chaos.fail_catalog,
                chaos.fail_publish,
                chaos.worker_latency_ms,
                chaos.catalog_latency_ms,
                chaos.bff_latency_ms,
            ]
        ))
        for key, value in chaos.model_dump().items():
            span.set_attribute(f"chaos.{key}", value)

        await apply_delay(chaos.orders_latency_ms, "orders")

        product = await fetch_product(body.product_id, chaos)
        amount_cents = int(product["price_cents"]) * body.quantity
        currency = product.get("currency", "usd")
        order_id = str(uuid.uuid4())
        span.set_attribute("order.id", order_id)
        span.set_attribute("order.amount_cents", amount_cents)

        weather_temp = await fetch_weather(body.latitude, body.longitude, chaos)
        stripe_pi, stripe_req = await create_stripe_intent(
            amount_cents, currency, order_id, chaos
        )

        chaos_payload = chaos.model_dump()
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO orders (
                      id, product_id, quantity, status, weather_temp_c,
                      stripe_payment_intent_id, stripe_request_id, chaos_flags
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        order_id,
                        body.product_id,
                        body.quantity,
                        "pending",
                        weather_temp,
                        stripe_pi,
                        stripe_req,
                        json.dumps(chaos_payload),
                    ),
                )
            conn.commit()

        payload = {
            "id": order_id,
            "product_id": body.product_id,
            "quantity": body.quantity,
            "amount_cents": amount_cents,
            "currency": currency,
            "weather_temp_c": weather_temp,
            "stripe_payment_intent_id": stripe_pi,
            "chaos": chaos_payload,
        }

        publish_error: Optional[str] = None
        if chaos.fail_publish:
            with tracer.start_as_current_span("orders.publish_order_created") as pub_span:
                pub_span.set_attribute("chaos.fail_publish", True)
                pub_span.set_status(Status(StatusCode.ERROR, "chaos fail_publish"))
            publish_error = "chaos_publish_failure"
        else:
            try:
                publish_order_created(payload)
            except Exception as exc:
                logger.exception("publish failed for %s", order_id)
                span.record_exception(exc)
                span.set_status(Status(StatusCode.ERROR, "publish_failure"))
                publish_error = f"publish_failure: {exc}"

        if publish_error:
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE orders
                        SET status = 'failed',
                            error_message = %s,
                            updated_at = NOW()
                        WHERE id = %s
                        """,
                        (publish_error, order_id),
                    )
                conn.commit()

        await apply_delay(chaos.slow_close_ms, "slow_close")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        span.set_attribute("http.server.duration_ms", elapsed_ms)
        logger.info("order created id=%s product_id=%s elapsed_ms=%s", order_id, body.product_id, elapsed_ms)

        return {
            "id": order_id,
            "product_id": body.product_id,
            "quantity": body.quantity,
            "status": "failed" if publish_error else "pending",
            "amount_cents": amount_cents,
            "currency": currency,
            "weather_temp_c": weather_temp,
            "stripe_payment_intent_id": stripe_pi,
            "stripe_request_id": stripe_req,
            "error_message": publish_error,
            "chaos": chaos_payload,
            "feature_flag_source": "openfeature/flagd",
            "peer_calls": {
                "open_meteo": "failed" if chaos.fail_open_meteo else "always",
                "stripe": (
                    "failed"
                    if chaos.fail_stripe
                    else ("enabled" if STRIPE_SECRET_KEY else "skipped")
                ),
            },
        }
