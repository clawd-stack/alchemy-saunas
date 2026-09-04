/**
 * Tiny API client shared by the pages.
 *
 * Every page talks to our own /api endpoints. Nothing here holds a credential:
 * Hapana keys live server-side only, and the session is an HttpOnly cookie the
 * browser cannot read. PRD 8, and acceptance criterion 11.
 */
export const api = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(payload?.message || 'Something went wrong. Please try again.');
      error.code = payload?.code || 'INTERNAL';
      error.status = response.status;
      error.detail = payload?.detail ?? null;
      // The whole body, so a caller that returns structured problems (the
      // config screen's validation issues) can read them without a second fetch.
      error.payload = payload;
      throw error;
    }
    return payload;
  },
  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body }); },
  patch(path, body) { return this.request(path, { method: 'PATCH', body }); },
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function notice(container, kind, message) {
  container.innerHTML = '';
  if (!message) return;
  container.append(el('div', { class: `notice notice--${kind}`, text: message }));
}

export function money(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}
