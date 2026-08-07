import 'zone.js';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { propagation, trace } from '@opentelemetry/api';

function resolveOtlpBase() {
  const configured = (import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  // Prefer same-origin nginx proxy (/otlp) so RUM works without opening :4318 in the browser.
  if (!configured || configured === 'same-origin' || configured === '/otlp') {
    return `${window.location.origin}/otlp`;
  }
  return configured;
}

const otlpEndpoint = resolveOtlpBase();
const sessionId =
  sessionStorage.getItem('otel.session_id') ||
  (() => {
    const id = crypto.randomUUID();
    sessionStorage.setItem('otel.session_id', id);
    return id;
  })();

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const exporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
});

const provider = new WebTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'frontend-rum',
    'service.namespace': 'otel-demo',
    'service.version': '1.0.0',
    'session.id': sessionId,
    'browser.platform': navigator.platform || 'unknown',
  }),
});

const processor = new BatchSpanProcessor(exporter, {
  maxExportBatchSize: 32,
  scheduledDelayMillis: 1000,
});
provider.addSpanProcessor(processor);

provider.register({
  contextManager: new ZoneContextManager(),
});

registerInstrumentations({
  instrumentations: [
    new DocumentLoadInstrumentation(),
    new UserInteractionInstrumentation({ eventNames: ['click', 'submit'] }),
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: [/.*/],
      clearTimingResources: true,
      ignoreUrls: [/\/otlp\//],
    }),
  ],
});

function flushRum() {
  return provider.forceFlush?.() || Promise.resolve();
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushRum();
});
window.addEventListener('pagehide', () => {
  flushRum();
});

console.info('[rum] exporting traces to', `${otlpEndpoint}/v1/traces`, 'session', sessionId);

/** Emit a page-view span on client-side route changes (SPA RUM). */
export function recordRouteView(path) {
  const span = trace.getTracer('frontend-rum').startSpan('ui.page_view');
  span.setAttribute('session.id', sessionId);
  span.setAttribute('url.path', path);
  span.setAttribute('http.route', path);
  span.end();
}

export { provider, sessionId, flushRum };
export default provider;
