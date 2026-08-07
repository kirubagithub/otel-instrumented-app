import { useEffect, useState } from 'react';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { api } from '../lib/api.js';
import { BOOL_FIELDS, DEFAULT_CHAOS, LATENCY_FIELDS } from '../lib/chaos.js';

const tracer = trace.getTracer('frontend-rum');

export default function GatesPage() {
  const [chaos, setChaos] = useState(DEFAULT_CHAOS);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const span = tracer.startSpan('ui.gates_view');
    api('/api/flags/chaos')
      .then((data) => {
        if (data?.chaos) setChaos({ ...DEFAULT_CHAOS, ...data.chaos });
      })
      .catch((e) => {
        span.recordException(e);
        setError(e.message);
      })
      .finally(() => span.end());
  }, []);

  function setField(key, value) {
    setChaos((prev) => ({ ...prev, [key]: value }));
  }

  async function apply(e) {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    setError('');
    const span = tracer.startSpan('ui.apply_feature_gates');
    try {
      const data = await api('/api/flags/chaos', {
        method: 'PUT',
        body: JSON.stringify({ chaos }),
      });
      if (data.chaos) setChaos({ ...DEFAULT_CHAOS, ...data.chaos });
      setMsg('Feature gates applied via OpenFeature / flagd (hot reload).');
      span.setAttribute('feature_flag.source', 'openfeature/flagd');
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
      setSaving(false);
    }
  }

  async function resetAll() {
    setChaos(DEFAULT_CHAOS);
    setSaving(true);
    try {
      await api('/api/flags/chaos', {
        method: 'PUT',
        body: JSON.stringify({ chaos: DEFAULT_CHAOS }),
      });
      setMsg('All chaos gates turned off.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel narrow">
      <h1>Feature gates</h1>
      <p className="hint">
        OpenFeature / flagd control plane for synthesized errors and latency.
        Changes apply to subsequent requests across BFF, orders, and worker — not only this browser tab.
      </p>

      <form className="form" onSubmit={apply}>
        <h2 className="subhead">Latency & lag</h2>
        <div className="chaos-grid">
          {LATENCY_FIELDS.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min="0"
                max="60000"
                step="100"
                value={chaos[key]}
                onChange={(e) => setField(key, Number(e.target.value) || 0)}
              />
            </label>
          ))}
        </div>

        <h2 className="subhead">Failure switches</h2>
        <div className="checks">
          {BOOL_FIELDS.map(([key, label]) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={!!chaos[key]}
                onChange={(e) => setField(key, e.target.checked)}
              />
              <span>{label}</span>
              <span className={`gate-state ${chaos[key] ? 'on' : 'off'}`}>
                {chaos[key] ? 'ON' : 'OFF'}
              </span>
            </label>
          ))}
        </div>

        <div className="row-actions">
          <button type="submit" disabled={saving}>{saving ? 'Applying…' : 'Apply gates'}</button>
          <button type="button" className="ghost" onClick={resetAll} disabled={saving}>Reset all OFF</button>
        </div>
      </form>
      {msg && <p className="hint">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
