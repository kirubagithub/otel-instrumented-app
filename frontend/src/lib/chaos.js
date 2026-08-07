export const DEFAULT_CHAOS = {
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

export const LATENCY_FIELDS = [
  ['bff_latency_ms', 'BFF latency (ms)'],
  ['catalog_latency_ms', 'Catalog latency (ms)'],
  ['orders_latency_ms', 'Orders latency (ms)'],
  ['worker_latency_ms', 'Worker latency (ms)'],
  ['queue_lag_ms', 'Queue lag (ms)'],
  ['slow_close_ms', 'Slow response close (ms)'],
];

export const BOOL_FIELDS = [
  ['fail_open_meteo', 'Fail Open-Meteo'],
  ['fail_stripe', 'Fail Stripe'],
  ['fail_jsonplaceholder', 'Fail JSONPlaceholder'],
  ['fail_catalog', 'Fail catalog call'],
  ['fail_publish', 'Fail queue publish'],
];

export function statusClass(status) {
  if (status === 'processed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'processing') return 'warn';
  return 'muted';
}
