import json
import logging
import os
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

from telemetry import setup_telemetry

logger = logging.getLogger("orders-service")
app = FastAPI(title="orders-service")
tracer = setup_telemetry(app)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://otel:otel@localhost:5432/otel_demo")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://otel:otel@localhost:5672/")
CATALOG_URL = os.getenv("CATALOG_URL", "http://localhost:8082").rstrip("/")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


class CreateOrderRequest(BaseModel):
    product_id: int
    quantity: int = Field(ge=1, le=100)
    latitude: float = 40.71
    longitude: float = -74.01


def get_conn():
    return psycopg.connect(DATABASE_URL)


def publish_order_created(payload: dict[str, Any]) -> None:
    with tracer.start_as_current_span("orders.publish_order_created") as span:
        span.set_attribute("messaging.system", "rabbitmq")
        span.set_attribute("messaging.destination.name", "orders.created")
        span.set_attribute("order.id", payload.get("id", ""))

        headers: dict[str, str] = {}
        inject(headers)

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
                headers=headers,
            ),
        )
        connection.close()


async def fetch_product(product_id: int) -> dict[str, Any]:
    headers: dict[str, str] = {}
    inject(headers)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{CATALOG_URL}/products/{product_id}", headers=headers)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="product_not_found")
        resp.raise_for_status()
        return resp.json()


async def fetch_weather(lat: float, lon: float) -> Optional[float]:
    """Call Open-Meteo — creates an HTTP CLIENT span to a third-party API."""
    with tracer.start_as_current_span("orders.call_open_meteo") as span:
        span.set_attribute("peer.service", "open-meteo")
        span.set_attribute("dependency.type", "third_party")
        span.set_attribute("geo.lat", lat)
        span.set_attribute("geo.lon", lon)
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


async def create_stripe_intent(amount_cents: int, currency: str, order_id: str) -> tuple[Optional[str], Optional[str]]:
    """Optional Stripe PaymentIntent — CLIENT-side third-party span enrichment."""
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


@app.get("/health")
def health():
    return {"status": "ok", "service": "orders-service"}


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, product_id, quantity, status, weather_temp_c, exchange_rate,
                       stripe_payment_intent_id, stripe_request_id, external_ref, created_at, updated_at
                FROM orders WHERE id = %s
                """,
                (order_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="order_not_found")
            keys = [
                "id",
                "product_id",
                "quantity",
                "status",
                "weather_temp_c",
                "exchange_rate",
                "stripe_payment_intent_id",
                "stripe_request_id",
                "external_ref",
                "created_at",
                "updated_at",
            ]
            return {k: (str(v) if hasattr(v, "isoformat") or isinstance(v, uuid.UUID) else v) for k, v in zip(keys, row)}


@app.post("/orders")
async def create_order(body: CreateOrderRequest):
    with tracer.start_as_current_span("orders.create_order") as span:
        span.set_attribute("order.product_id", body.product_id)
        span.set_attribute("order.quantity", body.quantity)

        product = await fetch_product(body.product_id)
        amount_cents = int(product["price_cents"]) * body.quantity
        currency = product.get("currency", "usd")
        order_id = str(uuid.uuid4())
        span.set_attribute("order.id", order_id)
        span.set_attribute("order.amount_cents", amount_cents)

        weather_temp = await fetch_weather(body.latitude, body.longitude)
        stripe_pi, stripe_req = await create_stripe_intent(amount_cents, currency, order_id)

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO orders (
                      id, product_id, quantity, status, weather_temp_c,
                      stripe_payment_intent_id, stripe_request_id
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        order_id,
                        body.product_id,
                        body.quantity,
                        "pending",
                        weather_temp,
                        stripe_pi,
                        stripe_req,
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
        }
        publish_order_created(payload)
        logger.info("order created id=%s product_id=%s", order_id, body.product_id)

        return {
            "id": order_id,
            "product_id": body.product_id,
            "quantity": body.quantity,
            "status": "pending",
            "amount_cents": amount_cents,
            "currency": currency,
            "weather_temp_c": weather_temp,
            "stripe_payment_intent_id": stripe_pi,
            "stripe_request_id": stripe_req,
            "peer_calls": {
                "open_meteo": "always",
                "stripe": "enabled" if STRIPE_SECRET_KEY else "skipped",
            },
        }
