import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { api } from '../lib/api.js';
import { statusClass } from '../lib/chaos.js';

const tracer = trace.getTracer('frontend-rum');

export default function OrdersPage() {
  const [params] = useSearchParams();
  const highlight = params.get('highlight');
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);

  const loadOrders = useCallback(async () => {
    try {
      const data = await api('/api/orders?limit=100');
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    const span = tracer.startSpan('ui.orders_view');
    loadOrders().finally(() => span.end());
    const timer = setInterval(loadOrders, 2000);
    return () => clearInterval(timer);
  }, [loadOrders]);

  async function clearOrders() {
    if (!window.confirm('Delete all orders from Postgres?')) return;
    setClearing(true);
    const span = tracer.startSpan('ui.clear_orders');
    try {
      await api('/api/orders', { method: 'DELETE' });
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
    <section className="panel table-panel">
      <div className="table-head">
        <h1>Orders</h1>
        <div className="table-actions">
          <button type="button" className="ghost" onClick={loadOrders}>Refresh</button>
          <button type="button" className="danger" onClick={clearOrders} disabled={clearing || orders.length === 0}>
            {clearing ? 'Clearing…' : 'Clear all'}
          </button>
        </div>
      </div>
      <p className="hint tight">
        Status should move <code>pending</code> → <code>processing</code> → <code>processed</code> / <code>failed</code>
        with a worker external ref. Auto-refreshes every 2s from Postgres.
      </p>
      {error && <p className="error">{error}</p>}
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
              <tr><td colSpan="7" className="empty">No orders yet</td></tr>
            )}
            {orders.map((o) => (
              <tr key={o.id} className={o.id === highlight ? 'active' : ''}>
                <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '—'}</td>
                <td><code title={o.id}>{String(o.id).slice(0, 8)}</code></td>
                <td><span className={`pill ${statusClass(o.status)}`}>{o.status}</span></td>
                <td>{o.quantity}</td>
                <td>{o.stripe_payment_intent_id ? `${String(o.stripe_payment_intent_id).slice(0, 12)}…` : '—'}</td>
                <td>{o.external_ref || '—'}</td>
                <td className="err-cell">{o.error_message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
