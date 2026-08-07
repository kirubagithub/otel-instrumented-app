import { Link } from 'react-router-dom';
import { sessionId } from '../otel.js';
import { getUser } from '../lib/session.js';

export default function HomePage() {
  const user = getUser();
  return (
    <section className="hero-block">
      <p className="brand">OTel Lab</p>
      <h1>Multi-page journeys for RUM, traces, and chaos</h1>
      <p className="lede">
        Walk login → catalog → checkout → orders while OpenTelemetry captures page loads,
        clicks, and backend traces. Flip feature gates to plant intermittent failures.
      </p>
      <p className="session">RUM session <code>{sessionId}</code>
        {user ? <> · signed in as <code>{user.email}</code></> : null}
      </p>
      <div className="row-actions">
        <Link className="button-link" to={user ? '/catalog' : '/login'}>
          {user ? 'Browse catalog' : 'Start with login'}
        </Link>
        <Link className="button-link ghost-link" to="/gates">Feature gates</Link>
        <Link className="button-link ghost-link" to="/orders">Orders</Link>
      </div>
    </section>
  );
}
