import { useEffect, useState } from 'react';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const BFF = (import.meta.env.VITE_BFF_URL || 'http://localhost:3000').replace(/\/$/, '');
const tracer = trace.getTracer('frontend-rum');

export default function App() {
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [poll, setPoll] = useState(null);

  useEffect(() => {
    const span = tracer.startSpan('ui.load_products');
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
  }, []);

  async function createOrder(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setPoll(null);

    const span = tracer.startSpan('ui.create_order_click');
    span.setAttribute('order.product_id', Number(productId));
    span.setAttribute('order.quantity', Number(quantity));

    try {
      const res = await fetch(`${BFF}/api/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: Number(productId),
          quantity: Number(quantity),
          latitude: 40.71,
          longitude: -74.01,
        }),
      });
      const data = await res.json();
      span.setAttribute('http.status_code', res.status);
      if (!res.ok) throw new Error(data.detail || data.error || `order ${res.status}`);
      if (data.id) span.setAttribute('order.id', data.id);
      if (data.stripe_payment_intent_id) {
        span.setAttribute('stripe.payment_intent_id', data.stripe_payment_intent_id);
      }
      setResult(data);
      pollOrder(data.id);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
      setLoading(false);
    }
  }

  function pollOrder(id) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(`${BFF}/api/orders/${id}`);
        const data = await r.json();
        setPoll(data);
        if (data.status === 'processed' || tries >= 15) clearInterval(timer);
      } catch {
        if (tries >= 15) clearInterval(timer);
      }
    }, 1000);
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="brand">OTel Lab</p>
        <h1>Watch one order cross five services</h1>
        <p className="lede">
          RUM → BFF → catalog → orders → Open-Meteo / Stripe → RabbitMQ → worker → JSONPlaceholder,
          all exported through the OpenTelemetry Collector to OpenObserve.
        </p>
      </header>

      <main className="panel">
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

        {error && <p className="error">{error}</p>}

        {result && (
          <section className="result">
            <h2>Order created</h2>
            <dl>
              <div><dt>Order ID</dt><dd><code>{result.id}</code></dd></div>
              <div><dt>Status</dt><dd>{poll?.status || result.status}</dd></div>
              <div><dt>Weather °C (Open-Meteo)</dt><dd>{result.weather_temp_c ?? '—'}</dd></div>
              <div><dt>Stripe PI</dt><dd>{result.stripe_payment_intent_id || 'skipped (no key)'}</dd></div>
              <div><dt>Worker external ref</dt><dd>{poll?.external_ref || 'waiting…'}</dd></div>
            </dl>
            <p className="hint">
              In OpenObserve, search traces by <code>order.id = {result.id}</code> or filter{' '}
              <code>dependency.type = third_party</code> / <code>peer.service</code>.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
