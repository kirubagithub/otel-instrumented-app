"""
Locust user journeys for the OTel microservices lab.

Simulates: login → catalog → browse → checkout → poll orders → (optional) flip chaos gates.
Generates backend traces/metrics; pair with Playwright for real browser RUM.

Run (Compose):
  docker compose --profile loadgen up locust
  open http://localhost:8089

Run (local):
  pip install -r requirements.txt
  locust -f locustfile.py --host http://localhost:3000
"""

from __future__ import annotations

import os
import random
import time
from typing import Any

from locust import HttpUser, between, events, task


BFF_HOST = os.getenv("BFF_HOST", "")  # Locust --host usually set
CHAOS_INTERMITTENT = os.getenv("CHAOS_INTERMITTENT", "true").lower() in ("1", "true", "yes")


def _chaos_burst() -> dict[str, Any]:
    """Random intermittent failure/latency profile for a subset of users."""
    profiles = [
        {},
        {"orders_latency_ms": 800},
        {"queue_lag_ms": 1500, "worker_latency_ms": 500},
        {"fail_open_meteo": True},
        {"fail_jsonplaceholder": True},
        {"bff_latency_ms": 400, "catalog_latency_ms": 400},
        {"slow_close_ms": 1000},
    ]
    return random.choice(profiles)


class ShopperUser(HttpUser):
    wait_time = between(1, 3)
    abstract = False

    def on_start(self):
        self.user_id = f"locust-{random.randint(1000, 9999)}"
        self.email = f"{self.user_id}@example.com"
        self.name = f"Locust {self.user_id}"
        self.product_ids: list[int] = []
        self._login()
        self._load_catalog()
        if CHAOS_INTERMITTENT and random.random() < 0.25:
            self._maybe_apply_chaos()

    def _login(self):
        with self.client.post(
            "/api/session/login",
            json={"id": self.user_id, "email": self.email, "name": self.name},
            name="POST /api/session/login",
            catch_response=True,
        ) as res:
            if res.status_code != 200:
                res.failure(f"login {res.status_code}")

    def _load_catalog(self):
        with self.client.get("/api/products", name="GET /api/products", catch_response=True) as res:
            if res.status_code != 200:
                res.failure(f"catalog {res.status_code}")
                return
            data = res.json()
            self.product_ids = [p["id"] for p in data if "id" in p]

    def _maybe_apply_chaos(self):
        chaos = _chaos_burst()
        if not chaos:
            return
        with self.client.put(
            "/api/flags/chaos",
            json={"chaos": chaos},
            name="PUT /api/flags/chaos (intermittent)",
            catch_response=True,
        ) as res:
            if res.status_code >= 400:
                res.failure(f"flags {res.status_code}")

    @task(3)
    def browse_catalog(self):
        self.client.get("/api/products", name="GET /api/products")

    @task(5)
    def checkout_flow(self):
        if not self.product_ids:
            self._load_catalog()
        if not self.product_ids:
            return
        product_id = random.choice(self.product_ids)
        qty = random.randint(1, 3)
        with self.client.post(
            "/api/orders",
            json={
                "product_id": product_id,
                "quantity": qty,
                "latitude": 40.71 + random.random(),
                "longitude": -74.01 + random.random(),
            },
            name="POST /api/orders",
            catch_response=True,
        ) as res:
            if res.status_code >= 400:
                # Chaos may intentionally fail some requests
                if res.status_code in (502, 503):
                    res.success()
                else:
                    res.failure(f"order {res.status_code}")
                return
            order = res.json()
            order_id = order.get("id")
            if not order_id:
                res.failure("missing order id")
                return

        # Poll until worker updates status (or timeout)
        deadline = time.time() + 20
        while time.time() < deadline:
            with self.client.get(
                f"/api/orders/{order_id}",
                name="GET /api/orders/:id (poll)",
                catch_response=True,
            ) as poll:
                if poll.status_code != 200:
                    poll.failure(f"poll {poll.status_code}")
                    break
                body = poll.json()
                status = body.get("status")
                if status in ("processed", "failed"):
                    poll.success()
                    break
            time.sleep(1)

    @task(1)
    def list_orders(self):
        self.client.get("/api/orders?limit=20", name="GET /api/orders")

    @task(1)
    def accountish_health(self):
        # Lightweight bounce similar to opening account/home APIs
        self.client.get("/health", name="GET /health")


@events.test_start.add_listener
def on_test_start(environment, **_kwargs):
    print("Locust shopper journeys starting — host=", environment.host)
    print("CHAOS_INTERMITTENT=", CHAOS_INTERMITTENT)
