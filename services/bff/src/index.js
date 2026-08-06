import express from 'express';
import cors from 'cors';
import { request } from 'undici';
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';

const app = express();
const port = Number(process.env.PORT || 3000);
const ordersUrl = (process.env.ORDERS_URL || 'http://localhost:8081').replace(/\/$/, '');
const catalogUrl = (process.env.CATALOG_URL || 'http://localhost:8082').replace(/\/$/, '');
const tracer = trace.getTracer('bff-service');

app.use(cors());
app.use(express.json());

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forwardJson(method, url, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  propagation.inject(context.active(), headers);

  const res = await request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { statusCode: res.statusCode, data };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bff-service' });
});

app.get('/api/products', async (_req, res) => {
  const span = tracer.startSpan('bff.get_products');
  try {
    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('GET', `${catalogUrl}/products`)
    );
    span.setAttribute('http.status_code', statusCode);
    res.status(statusCode).json(data);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'catalog_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.get('/api/orders', async (req, res) => {
  const span = tracer.startSpan('bff.list_orders');
  try {
    const limit = req.query.limit || 50;
    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('GET', `${ordersUrl}/orders?limit=${encodeURIComponent(limit)}`)
    );
    res.status(statusCode).json(data);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'orders_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.delete('/api/orders', async (_req, res) => {
  const span = tracer.startSpan('bff.clear_orders');
  try {
    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('DELETE', `${ordersUrl}/orders`)
    );
    if (data?.deleted != null) span.setAttribute('orders.deleted', data.deleted);
    res.status(statusCode).json(data);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'orders_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.post('/api/orders', async (req, res) => {
  const span = tracer.startSpan('bff.create_order');
  try {
    const chaos = req.body?.chaos || {};
    const bffLatency = Number(chaos.bff_latency_ms || 0);
    if (bffLatency > 0) {
      const delaySpan = tracer.startSpan('chaos.delay.bff');
      delaySpan.setAttribute('chaos.latency_ms', bffLatency);
      delaySpan.setAttribute('chaos.layer', 'bff');
      await sleep(bffLatency);
      delaySpan.end();
    }

    span.setAttribute('order.product_id', req.body?.product_id ?? '');
    span.setAttribute('order.quantity', req.body?.quantity ?? 0);
    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('POST', `${ordersUrl}/orders`, req.body)
    );
    span.setAttribute('http.status_code', statusCode);
    if (data?.id) span.setAttribute('order.id', data.id);
    if (data?.stripe_payment_intent_id) {
      span.setAttribute('stripe.payment_intent_id', data.stripe_payment_intent_id);
    }
    res.status(statusCode).json(data);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'orders_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const span = tracer.startSpan('bff.get_order');
  try {
    span.setAttribute('order.id', req.params.id);
    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('GET', `${ordersUrl}/orders/${req.params.id}`)
    );
    res.status(statusCode).json(data);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'orders_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.listen(port, () => {
  console.log(`bff-service listening on ${port}`);
});
