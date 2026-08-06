import { useCallback, useEffect, useMemo, useState } from 'react';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { sessionId } from './otel.js';

const BFF = (import.meta.env.VITE_BFF_URL || 'http://localhost:3000').replace(/\/$/, '');
const tracer = trace.getTracer('frontend-rum');

const DEFAULT_CHAOS = {
  bff_latency_ms: 0,
  catalog_latency_ms: 0,
  orders_latency_ms: 0,
  worker_latency_ms: 0,
  queue_lag_ms: 0,
  slow_close_ms: 0,
  fail_open_meteo: false,
  fail_stripe: false,
  fail_jsonplaceholder: false,
  fail_catalog: false,
  fail_publish: false,
};

function statusClass(status) {
  if (status === 'processed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'processing') return 'warn';
  return 'muted';
}

export default function App() {
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [chaos, setChaos] = useState(DEFAULT_CHAOS);
  const [lastCreatedId, setLastCreatedId] = useState(null);

  const loadOrders = useCallback(async () => {
    try {
      const r = await fetch(`${BFF}/api/orders?limit=100`);
      if (!r.ok) throw new Error(`list orders ${r.status}`);
      const data = await r.json();
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    const span = tracer.startSpan('ui.load_products');
    span.setAttribute('session.id', sessionId);
    fetch(`${BFF}/api/products`)
      .then(async (r) => {
        span.setAttribute('http.status_code', r.status);
        if (!r.ok) throw new Error(`catalog ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setProducts(data);
        if (data[0]?.id) setProductId(String(data[0].id));
      })
      .catch((e) => {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        setError(e.message);
      })
      .finally(() => span.end());

    loadOrders();
  }, [loadOrders]);

  // Keep order statuses fresh from Postgres (worker updates).
  useEffect(() => {
    const timer = setInterval(() => {
      loadOrders();
    }, 2000);
    return () => clearInterval(timer);
  }, [loadOrders]);

  const highlighted = useMemo(
    () => orders.find((o) => o.id === lastCreatedId) || null,
    [orders, lastCreatedId]
  );

  function setChaosField(key, value) {
    setChaos((prev) => ({ ...prev, [key]: value }));
  }

  async function createOrder(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const span = tracer.startSpan('ui.create_order_click');
    span.setAttribute('session.id', sessionId);
    span.setAttribute('order.product_id', Number(productId));
    span.setAttribute('order.quantity', Number(quantity));
    span.setAttribute('chaos.enabled', Object.values(chaos).some((v) => v && v !== 0));

    try {
      const res = await fetch(`${BFF}/api/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: Number(productId),
          quantity: Number(quantity),
          latitude: 40.71,
          longitude: -74.01,
          chaos,
        }),
      });
      const data = await res.json();
      span.setAttribute('http.status_code', res.status);
      if (!res.ok) {
        const detail = data.detail || data.error || `order ${res.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      if (data.id) {
        span.setAttribute('order.id', data.id);
        setLastCreatedId(data.id);
      }
      if (data.stripe_payment_intent_id) {
        span.setAttribute('stripe.payment_intent_id', data.stripe_payment_intent_id);
      }
      await loadOrders();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
      setLoading(false);
    }
  }

  async function clearOrders() {
    if (!window.confirm('Delete all orders from Postgres?')) return;
    setClearing(true);
    setError('');
    const span = tracer.startSpan('ui.clear_orders');
    try {
      const res = await fetch(`${BFF}/api/orders`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `clear ${res.status}`);
      span.setAttribute('orders.deleted', data.deleted ?? 0);
      setLastCreatedId(null);
      await loadOrders();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
      setClearing(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="brand">OTel Lab</p>
        <h1>Watch one order cross five services</h1>
        <p className="lede">
          RUM → BFF → catalog → orders → Open-Meteo / Stripe → RabbitMQ → worker → JSONPlaceholder,
          exported through the Collector to OpenObserve.
        </p>
        <p className="session">RUM session <code>{sessionId}</code></p>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>Create order</h2>
          <form onSubmit={createOrder} className="form">
            <label>
              Product
              <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — ${(p.priceCents ?? p.price_cents) / 100}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="1"
                max="20"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <button type="submit" disabled={loading || !productId}>
              {loading ? 'Creating…' : 'Create traced order'}
            </button>
          </form>

          <div className="chaos">
            <h3>Chaos / fault injection</h3>
            <p className="hint tight">
              Inject latency, queue lag, or third-party failures. Spans get <code>chaos.*</code> attributes.
            </p>
            <div className="chaos-grid">
              {[
                ['bff_latency_ms', 'BFF latency (ms)'],
                ['catalog_latency_ms', 'Catalog latency (ms)'],
                ['orders_latency_ms', 'Orders latency (ms)'],
                ['worker_latency_ms', 'Worker latency (ms)'],
                ['queue_lag_ms', 'Queue lag (ms)'],
                ['slow_close_ms', 'Slow response close (ms)'],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min="0"
                    max="60000"
                    step="100"
                    value={chaos[key]}
                    onChange={(e) => setChaosField(key, Number(e.target.value) || 0)}
                  />
                </label>
              ))}
            </div>
            <div className="checks">
              {[
                ['fail_open_meteo', 'Fail Open-Meteo'],
                ['fail_stripe', 'Fail Stripe'],
                ['fail_jsonplaceholder', 'Fail JSONPlaceholder'],
                ['fail_catalog', 'Fail catalog call'],
                ['fail_publish', 'Fail queue publish'],
              ].map(([key, label]) => (
                <label key={key} className="check">
                  <input
                    type="checkbox"
                    checked={!!chaos[key]}
                    onChange={(e) => setChaosField(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {error && <p className="error">{error}</p>}

          {highlighted && (
            <section className="result">
              <h3>Latest order</h3>
              <dl>
                <div><dt>Order ID</dt><dd><code>{highlighted.id}</code></dd></div>
                <div>
                  <dt>Status</dt>
                  <dd><span className={`pill ${statusClass(highlighted.status)}`}>{highlighted.status}</span></dd>
                </div>
                <div><dt>Weather °C</dt><dd>{highlighted.weather_temp_c ?? '—'}</dd></div>
                <div><dt>Stripe PI</dt><dd>{highlighted.stripe_payment_intent_id || 'skipped'}</dd></div>
                <div><dt>Worker ref</dt><dd>{highlighted.external_ref || '—'}</dd></div>
                <div><dt>Error</dt><dd>{highlighted.error_message || '—'}</dd></div>
              </dl>
            </section>
          )}
        </section>

        <section className="panel table-panel">
          <div className="table-head">
            <h2>Orders in Postgres</h2>
            <div className="table-actions">
              <button type="button" className="ghost" onClick={loadOrders}>Refresh</button>
              <button type="button" className="danger" onClick={clearOrders} disabled={clearing || orders.length === 0}>
                {clearing ? 'Clearing…' : 'Clear all'}
              </button>
            </div>
          </div>
          <p className="hint tight">
            Status updates from the worker (`pending` → `processing` → `processed` / `failed`). Correlate with OpenObserve via <code>order.id</code>.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Qty</th>
                  <th>Stripe</th>
                  <th>Worker ref</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 && (
                  <tr>
                    <td colSpan="7" className="empty">No orders yet</td>
                  </tr>
                )}
                {orders.map((o) => (
                  <tr key={o.id} className={o.id === lastCreatedId ? 'active' : ''}>
                    <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '—'}</td>
                    <td><code title={o.id}>{String(o.id).slice(0, 8)}</code></td>
                    <td><span className={`pill ${statusClass(o.status)}`}>{o.status}</span></td>
                    <td>{o.quantity}</td>
                    <td>{o.stripe_payment_intent_id ? String(o.stripe_payment_intent_id).slice(0, 12) + '…' : '—'}</td>
                    <td>{o.external_ref || '—'}</td>
                    <td className="err-cell">{o.error_message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
