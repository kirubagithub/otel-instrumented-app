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
# How long to wait for worker to reach processed/failed before counting a failure.
ORDER_POLL_SECONDS = float(os.getenv("ORDER_POLL_SECONDS", "45"))

# Full flag snapshot — PUT /api/flags/chaos only patches provided keys, so we always
# send the complete set to avoid sticky leftovers from intermittent bursts.
DEFAULT_CHAOS: dict[str, Any] = {
    "bff_latency_ms": 0,
    "catalog_latency_ms": 0,
    "orders_latency_ms": 0,
    "worker_latency_ms": 0,
    "queue_lag_ms": 0,
    "slow_close_ms": 0,
    "fail_open_meteo": False,
    "fail_stripe": False,
    "fail_jsonplaceholder": False,
    "fail_catalog": False,
    "fail_publish": False,
}


def _chaos_burst() -> dict[str, Any]:
    """Random intermittent failure/latency profile for a subset of users."""
    profiles = [
        {},
        {"orders_latency_ms": 800},
        {"queue_lag_ms": 1500, "worker_latency_ms": 500},
        {"fail_open_meteo": True},
        {"fail_jsonplaceholder": True},
        {"fail_stripe": True},
        {"fail_catalog": True},
        {"fail_publish": True},
        {"bff_latency_ms": 400, "catalog_latency_ms": 400},
        {"slow_close_ms": 1000},
    ]
    return random.choice(profiles)


def _apply_flags(client, chaos: dict[str, Any], name: str) -> None:
    """Write a full chaos snapshot (defaults merged with overrides)."""
    payload = {**DEFAULT_CHAOS, **chaos}
    with client.put(
        "/api/flags/chaos",
        json={"chaos": payload},
        name=name,
        catch_response=True,
    ) as res:
        if res.status_code >= 400:
            res.failure(f"flags {res.status_code}")
        else:
            res.success()


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
        # Full snapshot (defaults ⊕ burst) so previous keys cannot stick forever.
        # An empty burst clears all gates back to safe defaults.
        burst = _chaos_burst()
        label = "reset" if not burst else "intermittent"
        _apply_flags(self.client, burst, f"PUT /api/flags/chaos ({label})")

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
                # Surface intentional chaos / upstream faults in the Locust failure column.
                detail = ""
                try:
                    body = res.json()
                    detail = body.get("detail") or body.get("error") or ""
                except Exception:
                    detail = (res.text or "")[:120]
                res.failure(f"order {res.status_code}: {detail}")
                return
            order = res.json()
            order_id = order.get("id")
            if not order_id:
                res.failure("missing order id")
                return
            # Publish-failure chaos creates a failed row with HTTP 200 — treat as expected fail path.
            if order.get("status") == "failed":
                res.success()
                return

        # Poll until worker reaches a terminal status (or timeout → Locust failure).
        deadline = time.time() + ORDER_POLL_SECONDS
        last_status = "unknown"
        reached_terminal = False
        while time.time() < deadline:
            with self.client.get(
                f"/api/orders/{order_id}",
                name="GET /api/orders/:id (poll)",
                catch_response=True,
            ) as poll:
                if poll.status_code != 200:
                    poll.failure(f"poll {poll.status_code}")
                    return
                body = poll.json()
                last_status = body.get("status") or "unknown"
                if last_status in ("processed", "failed"):
                    poll.success()
                    reached_terminal = True
                    break
                poll.success()
            time.sleep(1)

        if not reached_terminal:
            with self.client.get(
                f"/api/orders/{order_id}",
                name="GET /api/orders/:id (stuck)",
                catch_response=True,
            ) as final:
                if final.status_code == 200:
                    last_status = final.json().get("status") or last_status
                if last_status not in ("processed", "failed"):
                    final.failure(
                        f"order stuck status={last_status} after {int(ORDER_POLL_SECONDS)}s"
                    )
                else:
                    final.success()

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
    print("ORDER_POLL_SECONDS=", ORDER_POLL_SECONDS)
    # Clear any leftover Gates / prior-run sticky flags before the swarm starts.
    if environment.runner is None:
        return
    try:
        host = environment.host or "http://bff:3000"
        import urllib.request

        req = urllib.request.Request(
            f"{host.rstrip('/')}/api/flags/chaos",
            data=__import__("json").dumps({"chaos": DEFAULT_CHAOS}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("chaos flags reset at test start:", resp.status)
    except Exception as exc:
        print("chaos reset at test start skipped:", exc)


@events.test_stop.add_listener
def on_test_stop(environment, **_kwargs):
    try:
        host = environment.host or "http://bff:3000"
        import json
        import urllib.request

        req = urllib.request.Request(
            f"{host.rstrip('/')}/api/flags/chaos",
            data=json.dumps({"chaos": DEFAULT_CHAOS}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("chaos flags reset at test stop:", resp.status)
    except Exception as exc:
        print("chaos reset at test stop skipped:", exc)
