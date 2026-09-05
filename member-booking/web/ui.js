import { api, el, notice } from '/api.js';

/**
 * Shared pieces. Every page was assembling the same card, table and empty
 * state by hand, which is how four screens end up with four slightly
 * different ideas of what a card is.
 */

export function card(children, className = '') {
  return el('div', { class: `card ${className}`.trim() }, children);
}

export function section(title, children) {
  return [el('h2', { text: title }), ...(Array.isArray(children) ? children : [children])];
}

export function empty(message, action) {
  return card([
    el('div', { class: 'empty' }, [
      el('p', { text: message }),
      action ?? null,
    ]),
  ]);
}

export function linkButton(href, text, className = 'btn-primary btn-inline') {
  return el('a', { class: className, href, style: 'display:inline-block;text-decoration:none', text });
}

export function table(headings, rows) {
  return el('div', { class: 'scroll-x' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, headings.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

export function field(label, control, hint) {
  return el('div', {}, [el('label', { text: label }), control, hint ? el('p', { class: 'hint', text: hint }) : null]);
}

export function figures(items) {
  return el('div', { class: 'figures' }, items.map(([value, label]) => el('div', {}, [el('strong', { text: String(value) }), label])));
}

/**
 * A button that disables itself while its work is in flight and re-enables on
 * failure. Every action button was reimplementing this, and the ones that
 * forgot could be double-fired.
 */
export function actionButton(text, className, run) {
  const button = el('button', { class: className, type: 'button', text });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await run();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  return button;
}

/**
 * The signed-out state, shown wherever a page needs a member and has none.
 * Not an error: a session simply running out is the ordinary case.
 */
export function signedOut(host, message = 'Please sign in.') {
  host.innerHTML = '';
  host.append(empty(message, linkButton('/booking.html', 'Sign in')));
}

/** Runs a loader, turning the two failures every page shares into one path. */
export async function load(host, messages, run) {
  host.innerHTML = '';
  host.append(el('p', { class: 'spinner', text: 'Loading…' }));
  try {
    const nodes = await run();
    host.innerHTML = '';
    host.append(...nodes.filter(Boolean));
  } catch (error) {
    if (error.code === 'UNAUTHENTICATED') return signedOut(host);
    host.innerHTML = '';
    if (error.code === 'FORBIDDEN') {
      host.append(el('p', { class: 'muted', text: 'You do not have access to this.' }));
      return;
    }
    if (messages) notice(messages, 'bad', error.message);
    else host.append(el('p', { class: 'muted', text: error.message }));
  }
}

export { api, el, notice };
