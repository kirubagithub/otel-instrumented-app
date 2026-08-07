const BFF = (import.meta.env.VITE_BFF_URL || 'http://localhost:3000').replace(/\/$/, '');

export { BFF };

export async function api(path, options = {}) {
  const res = await fetch(`${BFF}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.detail || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}
