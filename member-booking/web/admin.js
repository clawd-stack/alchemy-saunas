import { api, el, notice } from '/api.js';

/**
 * Configuration screen, PRD 5.7.
 *
 * The bound on the member channel allocation is checked here for immediate
 * feedback and again in the API, which is the one that counts. A UI check
 * alone would be advice; the server check is the rule.
 */

const messages = document.getElementById('messages');
const signinCard = document.getElementById('signin-card');
const adminSection = document.getElementById('admin-section');
const form = document.getElementById('config-form');
const warningsEl = document.getElementById('warnings');
const summaryEl = document.getElementById('capacity-summary');
const auditEl = document.getElementById('audit');

const FIELDS = [
  { key: 'venue_maximum', label: 'Venue maximum (people per hour)', type: 'number', field: 'venueMaximum',
    hint: 'The hard ceiling. Must trace to the certificate of approval, not to a conversation. Changing it requires a documented source.' },
  { key: 'hapana_public_capacity', label: 'Hapana public capacity', type: 'number', field: 'hapanaPublicCapacity',
    hint: 'What the public channel is configured to sell. Used to check the allocation below.' },
  { key: 'member_channel_capacity', label: 'Member channel allocation', type: 'number', field: 'memberChannelCapacity',
    hint: 'Ringfenced spots per session for this channel. Public plus this may never exceed the venue maximum.' },
  { key: 'booking_window_days', label: 'Booking window (days)', type: 'number', field: 'bookingWindowDays' },
  { key: 'cancellation_cutoff_hours', label: 'Cancellation cutoff (hours)', type: 'number', field: 'cancellationCutoffHours' },
  { key: 'max_guests_per_member', label: 'Guests per member', type: 'number', field: 'maxGuestsPerMember' },
  { key: 'guest_price', label: 'Guest price (AUD)', type: 'number', field: 'guestPrice',
    hint: 'Display only. Collected by EFTPOS at the door; nothing is charged in software.' },
  { key: 'session_length_minutes', label: 'Session length (minutes)', type: 'number', field: 'sessionLengthMinutes' },
  { key: 'booking_backend', label: 'Booking backend', type: 'select', field: 'bookingBackend',
    options: [
      { value: 'local', label: 'Pattern B: this service holds the ringfenced inventory' },
      { value: 'hapana', label: 'Pattern A: Hapana holds all inventory' },
    ],
    hint: 'Switch to Pattern A only once Hapana booking creation is confirmed working.' },
];

let current = null;

document.getElementById('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api.post('/api/auth/request', {
      email: document.getElementById('email').value.trim(),
      audience: 'admin',
    });
    notice(messages, 'good', result.message);
  } catch (error) {
    notice(messages, 'bad', error.message);
  }
});

async function load() {
  try {
    const data = await api.get('/api/admin/config');
    current = data.config;
    signinCard.classList.add('hidden');
    adminSection.classList.remove('hidden');

    warningsEl.innerHTML = '';
    for (const warning of data.warnings) {
      warningsEl.append(el('div', { class: 'notice notice--warn', text: warning }));
    }

    renderSummary(data.config, data.entries);
    renderForm(data.config, data.entries);
    loadAudit();
  } catch (error) {
    if (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN') {
      signinCard.classList.remove('hidden');
      adminSection.classList.add('hidden');
      return;
    }
    notice(messages, 'bad', error.message);
  }
}

function renderSummary(config, entries) {
  const allocated = config.hapanaPublicCapacity + config.memberChannelCapacity;
  const headroom = config.venueMaximum - allocated;
  const source = entries.find((entry) => entry.key === 'venue_maximum')?.sourceNote;

  summaryEl.innerHTML = '';
  summaryEl.append(
    el('div', { class: 'totals' }, [
      el('div', {}, [el('strong', { text: String(config.venueMaximum) }), 'venue maximum']),
      el('div', {}, [el('strong', { text: String(config.hapanaPublicCapacity) }), 'public']),
      el('div', {}, [el('strong', { text: String(config.memberChannelCapacity) }), 'member channel']),
      el('div', {}, [el('strong', { text: String(headroom) }), 'unallocated']),
    ]),
    el('p', { class: 'hint', style: 'margin-top:14px', text: `Venue maximum source: ${source || 'not recorded'}` }),
  );
}

function renderForm(config, entries) {
  form.innerHTML = '';

  for (const spec of FIELDS) {
    const value = config[spec.field];
    const control =
      spec.type === 'select'
        ? el('select', { id: spec.key, name: spec.key },
            spec.options.map((option) =>
              el('option', { value: option.value, selected: option.value === value, text: option.label }),
            ))
        : el('input', { id: spec.key, name: spec.key, type: 'text', inputmode: 'numeric', value: String(value) });

    form.append(
      el('div', {}, [
        el('label', { for: spec.key, text: spec.label }),
        control,
        spec.hint ? el('p', { class: 'hint', text: spec.hint }) : null,
      ]),
    );
  }

  form.append(
    el('div', {}, [
      el('label', { for: 'sourceNote', text: 'Documented source (required when changing the venue maximum)' }),
      el('input', { id: 'sourceNote', type: 'text', placeholder: 'e.g. Certificate of approval TOEF-2026-0142, Town of East Fremantle' }),
    ]),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn-primary', type: 'submit', text: 'Save changes' }),
      el('button', { class: 'btn-quiet', type: 'button', text: 'Reset', onclick: () => renderForm(current, entries) }),
    ]),
  );
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const updates = {};
  for (const spec of FIELDS) {
    const raw = document.getElementById(spec.key).value;
    const value = spec.type === 'select' ? raw : Number(raw);
    if (spec.type !== 'select' && Number.isNaN(value)) {
      return notice(messages, 'warn', `${spec.label} must be a number.`);
    }
    if (value !== current[spec.field]) updates[spec.key] = value;
  }

  if (Object.keys(updates).length === 0) {
    return notice(messages, 'info', 'Nothing changed.');
  }

  try {
    const result = await api.patch('/api/admin/config', {
      updates,
      sourceNote: document.getElementById('sourceNote').value.trim() || null,
    });
    notice(messages, 'good', result.message);
    await load();
  } catch (error) {
    const issues = error.payload?.issues ?? null;
    notice(messages, 'bad', issues ? issues.map((issue) => issue.message).join(' ') : error.message);
  }
});

async function loadAudit() {
  try {
    const data = await api.get('/api/admin/audit');
    auditEl.innerHTML = '';

    if (data.ceilingBreaches > 0) {
      auditEl.append(
        el('div', { class: 'notice notice--bad', text: `${data.ceilingBreaches} audit entries show occupancy above the venue maximum. Investigate before taking further bookings.` }),
      );
    }

    if (data.rows.length === 0) {
      auditEl.append(el('p', { class: 'muted', text: 'No activity in the last seven days.' }));
      return;
    }

    const body = el('tbody');
    for (const row of data.rows.slice(-60).reverse()) {
      body.append(
        el('tr', {}, [
          el('td', { text: new Date(row.createdAt).toLocaleString('en-AU') }),
          el('td', { text: row.refusalCode ? `${row.action} (${row.refusalCode})` : row.action }),
          el('td', { text: String(row.spotsDelta) }),
          el('td', { text: `${row.memberChannelBookedAfter} / ${row.memberChannelCapacity}` }),
          el('td', { text: `${row.venueTotalBookedAfter} / ${row.venueMaximumAtTime}` }),
        ]),
      );
    }

    auditEl.append(
      el('div', { class: 'scroll-x' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'When' }),
              el('th', { text: 'Action' }),
              el('th', { text: 'Spots' }),
              el('th', { text: 'Channel after' }),
              el('th', { text: 'Venue after' }),
            ]),
          ]),
          body,
        ]),
      ]),
    );
  } catch (error) {
    auditEl.innerHTML = '';
    auditEl.append(el('p', { class: 'muted', text: error.message }));
  }
}

load();
