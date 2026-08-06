-- Shared demo schema for orders + catalog services
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd'
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  weather_temp_c DOUBLE PRECISION,
  exchange_rate DOUBLE PRECISION,
  stripe_payment_intent_id TEXT,
  stripe_request_id TEXT,
  external_ref TEXT,
  error_message TEXT,
  chaos_flags JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO products (sku, name, price_cents, currency) VALUES
  ('WIDGET-1', 'Observability Widget', 1999, 'usd'),
  ('GADGET-2', 'Trace Gadget', 3499, 'usd'),
  ('PROBE-3', 'Log Probe', 999, 'usd')
ON CONFLICT (sku) DO NOTHING;
