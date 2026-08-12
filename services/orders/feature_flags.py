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


def _default_chaos() -> dict[str, Any]:
    return {
        key.replace("chaos.", "", 1): (False if key in _BOOL_FLAGS else 0)
        for key in _FLAG_KEYS
    }


def init_feature_flags() -> None:
    global _initialized
    if _initialized:
        return
    host = os.getenv("FLAGD_HOST", "flagd")
    port = int(os.getenv("FLAGD_PORT", "8013"))
    try:
        from openfeature.contrib.provider.flagd import FlagdProvider

        # openfeature-sdk >=0.8.2 passes flag_key=; provider must match (0.2.x; pin <=0.2.6 with OTel 1.29)
        api.set_provider(FlagdProvider(host=host, port=port, tls=False))
        _initialized = True
        logger.info("OpenFeature flagd provider ready at %s:%s", host, port)
    except Exception as exc:
        logger.warning("OpenFeature init failed (chaos flags disabled): %s", exc)


def _client():
    # openfeature-sdk uses domain= (not name=)
    return api.get_client(domain="orders-service")


def resolve_chaos(targeting_key: str | None = None) -> dict[str, Any]:
    """Evaluate chaos feature gates from flagd (outside control plane)."""
    out = _default_chaos()
    try:
        init_feature_flags()
        ctx = EvaluationContext(targeting_key=targeting_key or "anonymous")
        client = _client()
        for key in _FLAG_KEYS:
            short = key.replace("chaos.", "", 1)
            try:
                if key in _BOOL_FLAGS:
                    details = client.get_boolean_details(key, False, ctx)
                    if details.error_code:
                        logger.debug("flag %s error_code=%s", key, details.error_code)
                        continue
                    out[short] = bool(details.value)
                else:
                    details = client.get_integer_details(key, 0, ctx)
                    if details.error_code:
                        logger.debug("flag %s error_code=%s", key, details.error_code)
                        continue
                    out[short] = int(details.value or 0)
            except TypeError as exc:
                # Version skew between SDK and flagd provider — never break checkout
                logger.error(
                    "OpenFeature API mismatch evaluating %s (upgrade openfeature packages): %s",
                    key,
                    exc,
                )
                break
            except Exception as exc:
                logger.warning("flag eval failed for %s: %s", key, exc)
    except Exception as exc:
        logger.warning("resolve_chaos failed; using safe defaults: %s", exc)
    return out
