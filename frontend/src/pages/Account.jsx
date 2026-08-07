import { Link } from 'react-router-dom';
import { getUser } from '../lib/session.js';
import { sessionId } from '../otel.js';

export default function AccountPage() {
  const user = getUser();
  return (
    <section className="panel narrow">
      <h1>Account</h1>
      <p className="hint">Lightweight account page for RUM route coverage and session correlation.</p>
      {user ? (
        <dl>
          <div><dt>Name</dt><dd>{user.name}</dd></div>
          <div><dt>Email</dt><dd><code>{user.email}</code></dd></div>
          <div><dt>User id</dt><dd><code>{user.id}</code></dd></div>
          <div><dt>RUM session</dt><dd><code>{sessionId}</code></dd></div>
        </dl>
      ) : (
        <p className="hint">Not signed in. <Link to="/login">Login</Link> to attach <code>user.id</code> to spans.</p>
      )}
      <div className="row-actions">
        <Link className="button-link" to="/orders">My orders</Link>
        <Link className="button-link ghost-link" to="/checkout">Checkout</Link>
      </div>
    </section>
  );
}
