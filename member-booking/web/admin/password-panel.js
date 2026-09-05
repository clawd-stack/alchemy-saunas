import { el } from '/ui.js';

/**
 * The once-only password panel.
 *
 * Attached after the list refresh, never before: refreshing replaces the card
 * it lands in, and a panel attached first goes with it, taking the one value
 * in the system that cannot be recovered.
 */
export function showPassword(host, created) {
  const panel = el('div', { class: 'notice notice--good', style: 'margin-top:14px' }, [
    el('p', { style: 'margin:0 0 4px', text: created.message }),
    created.resolvesTo ? el('p', { class: 'hint', style: 'margin:0 0 10px', text: created.resolvesTo }) : null,
  ]);

  if (created.password) {
    panel.append(
      el('input', {
        type: 'text', readonly: 'readonly', value: created.password,
        style: 'font-family:ui-monospace,monospace;font-size:18px;letter-spacing:1px',
        onclick: (event) => event.target.select(),
      }),
    );
  }

  host.append(panel);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
