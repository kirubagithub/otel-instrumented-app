import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { api } from '../lib/api.js';
import { getUser, setUser, randomShopper } from '../lib/session.js';

const tracer = trace.getTracer('frontend-rum');

export default function LoginPage() {
  const [email, setEmail] = useState('demo@otel.lab');
  const [name, setName] = useState('Demo Shopper');
  const [user, setLocalUser] = useState(getUser());
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const onChange = () => setLocalUser(getUser());
    window.addEventListener('otel-user-changed', onChange);
    return () => window.removeEventListener('otel-user-changed', onChange);
  }, []);

  async function login(e) {
    e.preventDefault();
    setError('');
    const span = tracer.startSpan('ui.login');
    try {
      const payload = { email, name, id: `user-${email.split('@')[0]}` };
      span.setAttribute('user.email', email);
      span.setAttribute('user.id', payload.id);
      const data = await api('/api/session/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setUser(data.user || payload);
      setMsg('Signed in — browse catalog and checkout to generate RUM + traces.');
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      setError(err.message);
    } finally {
      span.end();
    }
  }

  async function quickRandom() {
    const shopper = randomShopper();
    setEmail(shopper.email);
    setName(shopper.name);
    const span = tracer.startSpan('ui.login_random');
    try {
      span.setAttribute('user.id', shopper.id);
      const data = await api('/api/session/login', {
        method: 'POST',
        body: JSON.stringify(shopper),
      });
      setUser(data.user || shopper);
      setMsg(`Signed in as ${shopper.email}`);
    } catch (err) {
      span.recordException(err);
      setError(err.message);
    } finally {
      span.end();
    }
  }

  async function logout() {
    const span = tracer.startSpan('ui.logout');
    try {
      await api('/api/session/logout', { method: 'POST', body: '{}' });
      setUser(null);
      setMsg('Signed out');
    } catch (err) {
      setUser(null);
      setMsg('Signed out locally');
    } finally {
      span.end();
    }
  }

  return (
    <section className="panel narrow">
      <h1>Login</h1>
      <p className="hint">
        Demo auth for multi-page RUM journeys. Locust / Playwright can hit this before catalog → checkout.
      </p>
      {user ? (
        <div className="result">
          <p>Signed in as <strong>{user.name}</strong> (<code>{user.email}</code>)</p>
          <div className="row-actions">
            <Link className="button-link" to="/catalog">Go to catalog</Link>
            <button type="button" className="ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={login}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <button type="submit">Sign in</button>
          <button type="button" className="ghost" onClick={quickRandom}>Random shopper</button>
        </form>
      )}
      {msg && <p className="hint">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
