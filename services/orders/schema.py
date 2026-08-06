"""Ensure schema works for both fresh and existing Postgres volumes."""
import logging

import psycopg

logger = logging.getLogger("orders-service")


def ensure_schema(database_url: str) -> None:
    statements = [
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS error_message TEXT",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS chaos_flags JSONB",
    ]
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            for sql in statements:
                cur.execute(sql)
        conn.commit()
    logger.info("orders schema ensured")
