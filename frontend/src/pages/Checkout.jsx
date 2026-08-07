import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { api } from '../lib/api.js';
import { getUser } from '../lib/session.js';

const tracer = trace.getTracer('frontend-rum');

export default function CheckoutPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState(params.get('product') || '');
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const user = getUser();

  useEffect(() => {
    const span = tracer.startSpan('ui.checkout_view');
    span.setAttribute('user.id', user?.id || 'anonymous');
    api('/api/products')
      .then((data) => {
        setProducts(data);
        if (!productId && data[0]?.id) setProductId(String(data[0].id));
      })
      .catch((e) => {
        span.recordException(e);
        setError(e.message);
      })
      .finally(() => span.end());
  }, []);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    const span = tracer.startSpan('ui.checkout_submit');
    span.setAttribute('order.product_id', Number(productId));
    span.setAttribute('order.quantity', Number(quantity));
    span.setAttribute('user.id', user?.id || 'anonymous');
    try {
      const data = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          product_id: Number(productId),
          quantity: Number(quantity),
          latitude: 40.71,
          longitude: -74.01,
        }),
      });
      span.setAttribute('order.id', data.id);
      if (data.stripe_payment_intent_id) {
        span.setAttribute('stripe.payment_intent_id', data.stripe_payment_intent_id);
      }
      setResult(data);
      setTimeout(() => navigate(`/orders?highlight=${data.id}`), 800);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
      setLoading(false);
    }
  }

  return (
    <section className="panel narrow">
      <h1>Checkout</h1>
      <p className="hint">
        Creates an order through BFF → orders → third parties → RabbitMQ → worker.
        {!user && <> Tip: <Link to="/login">sign in</Link> first for user-scoped RUM.</>}
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Product
          <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — ${((p.priceCents ?? p.price_cents) / 100).toFixed(2)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input type="number" min="1" max="20" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <button type="submit" disabled={loading || !productId}>
          {loading ? 'Placing order…' : 'Place order'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <p className="hint">
          Order <code>{result.id}</code> created ({result.status}). Redirecting to orders…
        </p>
      )}
    </section>
  );
}
