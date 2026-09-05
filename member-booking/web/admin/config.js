import { api, el, figures, notice } from '/ui.js';

/**
 * Channel settings and the waiver wording. Saved as a diff, so an untouched
 * field is never written and never appears in the audit trail.
 */

const FIELDS = [
  { key: 'member_channel_capacity', label: 'Spots per hour', field: 'memberChannelCapacity' },
  { key: 'venue_maximum', label: 'Venue ceiling', field: 'venueMaximum', optional: true },
  { key: 'hapana_public_capacity', label: 'Hapana public capacity', field: 'hapanaPublicCapacity' },
  { key: 'booking_window_days', label: 'Booking window (days)', field: 'bookingWindowDays' },
  { key: 'cancellation_cutoff_hours', label: 'Cancellation cutoff (hours)', field: 'cancellationCutoffHours' },
  { key: 'max_guests_per_member', label: 'Guests per member', field: 'maxGuestsPerMember' },
  { key: 'guest_price', label: 'Guest price', field: 'guestPrice' },
  { key: 'session_length_minutes', label: 'Session length (minutes)', field: 'sessionLengthMinutes' },
  {
    key: 'booking_backend', label: 'Booking backend', field: 'bookingBackend', type: 'select',
    options: [
      { value: 'local', label: 'Local inventory' },
      { value: 'hapana', label: 'Hapana inventory' },
    ],
  },
];

export function renderSummary(host, config) {
  const tiles = [
    [config.memberChannelCapacity, 'per hour'],
    [config.maxGuestsPerMember, 'guests each'],
    [`$${config.guestPrice}`, 'per guest'],
  ];
  if (config.venueMaximum !== null) tiles.push([config.venueMaximum, 'venue ceiling']);
  host.innerHTML = '';
  host.append(figures(tiles));
}

export function renderForm(form, config, entries, { messages, onSaved }) {
  form.innerHTML = '';

  for (const spec of FIELDS) {
    const value = config[spec.field];
    const control = spec.type === 'select'
      ? el('select', { id: spec.key }, spec.options.map((o) =>
          el('option', { value: o.value, selected: o.value === value, text: o.label })))
      : el('input', {
          id: spec.key, type: 'text', inputmode: 'numeric',
          placeholder: spec.optional ? 'None' : '',
          value: value === null || value === undefined ? '' : String(value),
        });
    form.append(el('div', {}, [el('label', { for: spec.key, text: spec.label }), control]));
  }

  const waiver = config.waiverText ?? { clauses: [], declaration: '', termsUrl: '', version: '' };
  form.append(
    el('h3', { style: 'margin:28px 0 0', text: 'Guest waiver' }),
    el('div', {}, [
      el('label', { for: 'waiver_version_field', text: 'Version' }),
      el('input', { id: 'waiver_version_field', type: 'text', value: waiver.version ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_terms_url', text: 'Terms of Use link' }),
      el('input', { id: 'waiver_terms_url', type: 'text', value: waiver.termsUrl ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_clauses', text: 'Clauses, one per line as "Heading | text"' }),
      el('textarea', { id: 'waiver_clauses', rows: '8' },
        [(waiver.clauses ?? []).map((c) => `${c.heading} | ${c.body}`).join('\n')]),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_declaration', text: 'Declaration' }),
      el('input', { id: 'waiver_declaration', type: 'text', value: waiver.declaration ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'sourceNote', text: 'Source, required when setting a venue ceiling' }),
      el('input', { id: 'sourceNote', type: 'text', placeholder: 'Certificate TOEF-2026-0142' }),
    ]),
    el('div', { class: 'row row--tight' }, [
      el('button', { class: 'btn-primary btn-inline', type: 'submit', text: 'Save' }),
      el('button', {
        class: 'btn-quiet', type: 'button', text: 'Reset',
        onclick: () => renderForm(form, config, entries, { messages, onSaved }),
      }),
    ]),
  );

  form.onsubmit = (event) => submit(event, config, { messages, onSaved });
}

async function submit(event, config, { messages, onSaved }) {
  event.preventDefault();
  const updates = {};

  for (const spec of FIELDS) {
    const raw = document.getElementById(spec.key).value.trim();
    let value;
    if (spec.type === 'select') {
      value = raw;
    } else if (spec.optional && raw === '') {
      value = null;
    } else {
      value = Number(raw);
      if (raw === '' || Number.isNaN(value)) return notice(messages, 'warn', `${spec.label} must be a number.`);
    }
    if (value !== config[spec.field]) updates[spec.key] = value;
  }

  const box = document.getElementById('waiver_clauses');
  if (box) {
    const clauses = box.value.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const split = line.indexOf('|');
      return split === -1
        ? { heading: '', body: line }
        : { heading: line.slice(0, split).trim(), body: line.slice(split + 1).trim() };
    });
    const next = {
      ...config.waiverText,
      clauses,
      termsUrl: document.getElementById('waiver_terms_url').value.trim(),
      declaration: document.getElementById('waiver_declaration').value.trim(),
      version: document.getElementById('waiver_version_field').value.trim(),
    };
    if (JSON.stringify(next) !== JSON.stringify(config.waiverText)) {
      updates.waiver_text = next;
      // The version is stamped on every signature: keep the two in step.
      if (next.version !== config.waiverVersion) updates.waiver_version = next.version;
    }
  }

  if (Object.keys(updates).length === 0) return notice(messages, 'info', 'Nothing changed.');

  try {
    const result = await api.patch('/api/admin/config', {
      updates,
      sourceNote: document.getElementById('sourceNote').value.trim() || null,
    });
    notice(messages, 'good', result.message);
    await onSaved();
  } catch (error) {
    const issues = error.payload?.issues ?? null;
    notice(messages, 'bad', issues ? issues.map((i) => i.message).join(' ') : error.message);
  }
}
