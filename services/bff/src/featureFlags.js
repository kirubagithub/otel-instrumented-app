import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';
import fs from 'node:fs/promises';
import path from 'node:path';

const FLAG_FILE = process.env.FLAGD_FILE || '/etc/flagd/chaos.flagd.json';

const LATENCY_KEYS = [
  'chaos.bff_latency_ms',
  'chaos.catalog_latency_ms',
  'chaos.orders_latency_ms',
  'chaos.worker_latency_ms',
  'chaos.queue_lag_ms',
  'chaos.slow_close_ms',
];

const BOOL_KEYS = [
  'chaos.fail_open_meteo',
  'chaos.fail_stripe',
  'chaos.fail_jsonplaceholder',
  'chaos.fail_catalog',
  'chaos.fail_publish',
];

let ready;
export function initFeatureFlags() {
  if (!ready) {
    const host = process.env.FLAGD_HOST || 'flagd';
    const port = Number(process.env.FLAGD_PORT || 8013);
    OpenFeature.setProvider(new FlagdProvider({ host, port, tls: false, deadline: 3000 }));
    ready = OpenFeature.setContext({ targetingKey: 'bff-service' }).then(() => {
      console.log(`OpenFeature flagd provider ready at ${host}:${port}`);
    }).catch((err) => {
      console.warn('OpenFeature init warning:', err.message);
    });
  }
  return ready;
}

function shortName(key) {
  return key.replace(/^chaos\./, '');
}

export async function resolveChaos(targetingKey = 'anonymous') {
  await initFeatureFlags();
  const client = OpenFeature.getClient('bff-service');
  const ctx = { targetingKey };
  const out = {};
  for (const key of LATENCY_KEYS) {
    out[shortName(key)] = await client.getNumberValue(key, 0, ctx);
  }
  for (const key of BOOL_KEYS) {
    out[shortName(key)] = await client.getBooleanValue(key, false, ctx);
  }
  return out;
}

function variantForNumber(value) {
  if (!value || value <= 0) return 'off';
  if (value >= 3000) return 'high';
  if (value >= 1000) return 'high';
  return 'low';
}

function numberVariantValue(flagKey, variant) {
  const defaults = {
    'chaos.bff_latency_ms': { off: 0, low: 500, high: 2000 },
    'chaos.catalog_latency_ms': { off: 0, low: 500, high: 2000 },
    'chaos.orders_latency_ms': { off: 0, low: 500, high: 2000 },
    'chaos.worker_latency_ms': { off: 0, low: 500, high: 2000 },
    'chaos.queue_lag_ms': { off: 0, low: 1000, high: 5000 },
    'chaos.slow_close_ms': { off: 0, low: 1000, high: 3000 },
  };
  return defaults[flagKey]?.[variant] ?? 0;
}

/**
 * Update flagd file on shared volume. flagd watches the file and hot-reloads.
 * This is the "outside" control plane for chaos feature gates.
 */
export async function updateChaosFlags(chaos) {
  const raw = await fs.readFile(FLAG_FILE, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc.flags) doc.flags = {};

  for (const key of LATENCY_KEYS) {
    const short = shortName(key);
    if (chaos[short] === undefined) continue;
    const ms = Number(chaos[short]) || 0;
    let variant = variantForNumber(ms);
    // If custom value doesn't match presets, inject a custom variant
    const variants = {
      off: 0,
      low: numberVariantValue(key, 'low'),
      high: numberVariantValue(key, 'high'),
    };
    if (ms > 0 && ms !== variants.low && ms !== variants.high) {
      variants.custom = ms;
      variant = 'custom';
    }
    doc.flags[key] = {
      state: 'ENABLED',
      variants,
      defaultVariant: variant,
    };
  }

  for (const key of BOOL_KEYS) {
    const short = shortName(key);
    if (chaos[short] === undefined) continue;
    const on = !!chaos[short];
    doc.flags[key] = {
      state: 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: on ? 'on' : 'off',
    };
  }

  const tmp = `${FLAG_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, FLAG_FILE);
  // Give flagd a moment to reload before callers re-evaluate
  await new Promise((r) => setTimeout(r, 400));
  return resolveChaos('flag-admin');
}

export async function readFlagFile() {
  const raw = await fs.readFile(FLAG_FILE, 'utf8');
  return JSON.parse(raw);
}

export { FLAG_FILE, LATENCY_KEYS, BOOL_KEYS };
