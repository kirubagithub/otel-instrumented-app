import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { api } from '../lib/api.js';

const tracer = trace.getTracer('frontend-rum');

export default function CatalogPage() {
  const [products, setProducts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const span = tracer.startSpan('ui.catalog_view');
    api('/api/products')
      .then((data) => setProducts(data))
      .catch((e) => {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        setError(e.message);
      })
      .finally(() => span.end());
  }, []);

  return (
    <section className="panel">
      <h1>Catalog</h1>
      <p className="hint">Product list from the Java catalog service (Postgres). Each card navigation emits RUM spans.</p>
      {error && <p className="error">{error}</p>}
      <div className="product-grid">
        {products.map((p) => (
          <article key={p.id} className="product">
            <h2>{p.name}</h2>
            <p className="price">${((p.priceCents ?? p.price_cents) / 100).toFixed(2)}</p>
            <p className="sku"><code>{p.sku}</code></p>
            <Link
              className="button-link"
              to={`/checkout?product=${p.id}`}
              onClick={() => {
                const span = tracer.startSpan('ui.select_product');
                span.setAttribute('product.id', p.id);
                span.end();
              }}
            >
              Buy
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
