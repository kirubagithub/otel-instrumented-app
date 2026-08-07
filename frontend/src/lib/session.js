const KEY = 'otel.lab.user';

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function setUser(user) {
  if (!user) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(user));
  window.dispatchEvent(new Event('otel-user-changed'));
}

export function randomShopper() {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return {
    id: `user-${n}`,
    email: `shopper${n}@example.com`,
    name: `Shopper ${n}`,
  };
}
