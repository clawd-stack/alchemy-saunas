import { api, el, field, notice } from '/ui.js';

/**
 * Channel settings, grouped by the question each group answers rather than
 * listed as one column of eleven boxes. The waiver used to live at the bottom
 * of this form; it is its own page now, because editing legal wording and
 * changing the guest price are not the same job and should not share a Save.
 *
 * Saved as a diff, so an untouched field is never written and never appears in
 * the audit trail.
 */

const GROUPS = [
  {
    title: 'Capacity',
    note: 'Public capacity plus the member allocation may never exceed the venue ceiling.',
    fields: [
      { key: 'member_channel_capacity', label: 'Member spots per hour', field: 'memberChannelCapacity' },
      { key: 'hapana_public_capacity', label: 'Hapana public capacity', field: 'hapanaPublicCapacity' },
      { key: 'venue_maximum', label: 'Venue ceiling', field: 'venueMaximum', optional: true },
    ],
  },
  {
    title: 'Booking window',
    fields: [
      { key: 'booking_window_days', label: 'Book up to (days ahead)', field: 'bookingWindowDays' },
      { key: 'cancellation_cutoff_hours', label: 'Cancellation cutoff (hours)', field: 'cancellationCutoffHours' },
      { key: 'session_length_minutes', label: 'Session length (minutes)', field: 'sessionLengthMinutes' },
    ],
  },
  {
    title: 'Guests',
    fields: [
      { key: 'max_guests_per_member', label: 'Guests per member', field: 'maxGuestsPerMember' },
      { key: 'guest_price', label: 'Guest price ($)', field: 'guestPrice' },
    ],
  },
  {
    title: 'Inventory',
    fields: [
      {
        key: 'booking_backend', label: 'Booking backend', field: 'bookingBackend', type: 'select',
        options: [
          { value: 'local', label: 'Local inventory' },
          { value: 'hapana', label: 'Hapana inventory' },
        ],
      },
    ],
  },
];

const FIELDS = GROUPS.flatMap((group) => group.fields);

export function renderSettings(form, config, { messages, onSaved }) {
  form.innerHTML = '';

  for (const group of GROUPS) {
    form.append(el('fieldset', { class: 'group' }, [
      el('legend', { text: group.title }),
      group.note ? el('p', { class: 'hint', text: group.note }) : null,
      el('div', { class: 'group__fields' }, [
        ...group.fields.map((spec) => control(spec, config)),
        // The server refuses a raised ceiling without a documented source, so
        // the box for it sits with the ceiling rather than under a Save
        // heading three groups further down.
        group.title === 'Capacity'
          ? field('Source, required when raising the ceiling',
              el('input', { id: 'sourceNote', type: 'text', placeholder: 'Certificate TOEF-2026-0142' }))
          : null,
      ].filter(Boolean)),
    ]));
  }

  form.append(
    el('div', { class: 'row row--tight' }, [
      el('button', { class: 'btn-primary btn-inline', type: 'submit', text: 'Save changes' }),
      el('button', {
        class: 'btn-quiet btn-small', type: 'button', text: 'Reset',
        onclick: () => renderSettings(form, config, { messages, onSaved }),
      }),
    ]),
  );

  form.onsubmit = (event) => submit(event, config, { messages, onSaved });
}

function control(spec, config) {
  const value = config[spec.field];
  const input = spec.type === 'select'
    ? el('select', { id: spec.key }, spec.options.map((o) =>
        el('option', { value: o.value, selected: o.value === value, text: o.label })))
    : el('input', {
        id: spec.key, type: 'text', inputmode: 'numeric',
        placeholder: spec.optional ? 'None' : '',
        value: value === null || value === undefined ? '' : String(value),
      });
  return field(spec.label, input);
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
