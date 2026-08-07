"""OpenFeature (flagd) client for chaos / error-scenario gates."""
from __future__ import annotations

import logging
import os
from typing import Any

from openfeature import api
from openfeature.evaluation_context import EvaluationContext

logger = logging.getLogger("orders-service")

_FLAG_KEYS = [
    "chaos.bff_latency_ms",
    "chaos.catalog_latency_ms",
    "chaos.orders_latency_ms",
    "chaos.worker_latency_ms",
    "chaos.queue_lag_ms",
    "chaos.slow_close_ms",
    "chaos.fail_open_meteo",
    "chaos.fail_stripe",
    "chaos.fail_jsonplaceholder",
    "chaos.fail_catalog",
    "chaos.fail_publish",
]

_BOOL_FLAGS = {
    "chaos.fail_open_meteo",
    "chaos.fail_stripe",
    "chaos.fail_jsonplaceholder",
    "chaos.fail_catalog",
    "chaos.fail_publish",
}

_initialized = False


def init_feature_flags() -> None:
    global _initialized
    if _initialized:
        return
    host = os.getenv("FLAGD_HOST", "flagd")
    port = int(os.getenv("FLAGD_PORT", "8013"))
    try:
        from openfeature.contrib.provider.flagd import FlagdProvider

        api.set_provider(FlagdProvider(host=host, port=port))
        _initialized = True
        logger.info("OpenFeature flagd provider ready at %s:%s", host, port)
    except Exception as exc:
        logger.warning("OpenFeature init failed (chaos flags disabled): %s", exc)


def _client():
    return api.get_client(name="orders-service")


def resolve_chaos(targeting_key: str | None = None) -> dict[str, Any]:
    """Evaluate chaos feature gates from flagd (outside control plane)."""
    init_feature_flags()
    ctx = EvaluationContext(targeting_key=targeting_key or "anonymous")
    client = _client()
    out: dict[str, Any] = {}
    for key in _FLAG_KEYS:
        short = key.replace("chaos.", "", 1)
        try:
            if key in _BOOL_FLAGS:
                out[short] = bool(client.get_boolean_value(key, False, ctx))
            else:
                out[short] = int(client.get_integer_value(key, 0, ctx))
        except Exception as exc:
            logger.warning("flag eval failed for %s: %s", key, exc)
            out[short] = False if key in _BOOL_FLAGS else 0
    return out
