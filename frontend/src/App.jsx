import { NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getUser } from './lib/session.js';
import { recordRouteView } from './otel.js';
import HomePage from './pages/Home.jsx';
import LoginPage from './pages/Login.jsx';
import CatalogPage from './pages/Catalog.jsx';
import CheckoutPage from './pages/Checkout.jsx';
import OrdersPage from './pages/Orders.jsx';
import GatesPage from './pages/Gates.jsx';
import AccountPage from './pages/Account.jsx';

function Shell() {
  const [user, setUser] = useState(getUser());
  const location = useLocation();

  useEffect(() => {
    const onChange = () => setUser(getUser());
    window.addEventListener('otel-user-changed', onChange);
    return () => window.removeEventListener('otel-user-changed', onChange);
  }, []);

  useEffect(() => {
    recordRouteView(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <div className="page">
      <nav className="nav">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/login">Login</NavLink>
        <NavLink to="/catalog">Catalog</NavLink>
        <NavLink to="/checkout">Checkout</NavLink>
        <NavLink to="/orders">Orders</NavLink>
        <NavLink to="/gates">Gates</NavLink>
        <NavLink to="/account">Account</NavLink>
        <span className="nav-user">{user ? user.email : 'guest'}</span>
      </nav>
      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="catalog" element={<CatalogPage />} />
        <Route path="checkout" element={<CheckoutPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="gates" element={<GatesPage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
    </Routes>
  );
}
