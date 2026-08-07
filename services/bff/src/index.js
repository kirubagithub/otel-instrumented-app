import express from 'express';
import cors from 'cors';
import { request } from 'undici';
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { initFeatureFlags, resolveChaos, updateChaosFlags } from './featureFlags.js';

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

initFeatureFlags();

// flagd stream errors must not take down the API gateway
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('FlagdProvider') || msg.includes('flagd')) {
    console.warn('[openfeature] swallowed flagd rejection:', msg);
    return;
  }
  console.error('unhandledRejection', reason);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bff-service' });
});

/** Demo session endpoints for multi-page RUM user journeys (not real auth). */
app.post('/api/session/login', (req, res) => {
  const span = tracer.startSpan('bff.session_login');
  try {
    const email = String(req.body?.email || '').trim();
    const name = String(req.body?.name || 'Shopper').trim();
    const id = String(req.body?.id || `user-${email.split('@')[0] || 'anon'}`);
    if (!email) {
      res.status(400).json({ error: 'email_required' });
      return;
    }
    span.setAttribute('user.id', id);
    span.setAttribute('user.email', email);
    res.json({ user: { id, email, name } });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(500).json({ error: 'login_failed', detail: err.message });
  } finally {
    span.end();
  }
});

app.post('/api/session/logout', (_req, res) => {
  const span = tracer.startSpan('bff.session_logout');
  try {
    res.json({ ok: true });
  } finally {
    span.end();
  }
});

app.get('/api/flags/chaos', async (_req, res) => {
  const span = tracer.startSpan('bff.get_chaos_flags');
  try {
    const chaos = await resolveChaos('bff-admin');
    span.setAttribute('feature_flag.source', 'openfeature/flagd');
    res.json({ source: 'openfeature/flagd', chaos });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(502).json({ error: 'flagd_unavailable', detail: err.message });
  } finally {
    span.end();
  }
});

app.put('/api/flags/chaos', async (req, res) => {
  const span = tracer.startSpan('bff.update_chaos_flags');
  try {
    span.setAttribute('feature_flag.source', 'openfeature/flagd');
    const chaos = await updateChaosFlags(req.body?.chaos || req.body || {});
    res.json({ source: 'openfeature/flagd', chaos, updated: true });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    res.status(500).json({ error: 'flag_update_failed', detail: err.message });
  } finally {
    span.end();
  }
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
    const flagChaos = await resolveChaos(String(req.body?.product_id || 'anonymous'));
    const bffLatency = Number(flagChaos.bff_latency_ms || 0);
    span.setAttribute('feature_flag.source', 'openfeature/flagd');
    span.setAttribute('chaos.bff_latency_ms', bffLatency);

    if (bffLatency > 0) {
      const delaySpan = tracer.startSpan('chaos.delay.bff');
      delaySpan.setAttribute('chaos.latency_ms', bffLatency);
      delaySpan.setAttribute('chaos.layer', 'bff');
      delaySpan.setAttribute('feature_flag.key', 'chaos.bff_latency_ms');
      await sleep(bffLatency);
      delaySpan.end();
    }

    span.setAttribute('order.product_id', req.body?.product_id ?? '');
    span.setAttribute('order.quantity', req.body?.quantity ?? 0);
    // Do not require clients to send chaos; services evaluate OpenFeature themselves.
    const body = { ...req.body };
    delete body.chaos;

    const { statusCode, data } = await context.with(trace.setSpan(context.active(), span), () =>
      forwardJson('POST', `${ordersUrl}/orders`, body)
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
