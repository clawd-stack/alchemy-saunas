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
  { key: 'member_channel_capacity', label: 'Spots per hour', type: 'number', field: 'memberChannelCapacity',
    hint: 'How many spots this channel sells per session. This is the limit that governs bookings.' },
  { key: 'venue_maximum', label: 'Venue ceiling (optional)', type: 'number', field: 'venueMaximum', optional: true,
    hint: 'Leave blank for no venue-wide ceiling, which is the default. Set a number only if a documented occupancy limit must be held across all channels, and record its source below.' },
  { key: 'hapana_public_capacity', label: 'Hapana public capacity', type: 'number', field: 'hapanaPublicCapacity',
    hint: 'Only used to validate the allocation against a venue ceiling. Ignored when no ceiling is set.' },
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

    renderEmailCheck();
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

/**
 * One-tap verification that email actually works. Everywhere else a send
 * failure is swallowed so it cannot take a booking down with it, which is
 * right in production and unhelpful during setup: this is the one place that
 * says plainly whether the credentials are good.
 */
function renderEmailCheck() {
  let host = document.getElementById('email-check');
  if (!host) {
    host = el('div', { class: 'card', id: 'email-check' });
    warningsEl.after(host);
  }
  host.innerHTML = '';
  host.append(
    el('div', { class: 'row row--between' }, [
      el('div', {}, [
        el('strong', { text: 'Email' }),
        el('p', { class: 'hint', style: 'margin:4px 0 0', text: 'Sends a real message to your own address and reports what the provider said.' }),
      ]),
      el('button', { class: 'btn-quiet btn-small', id: 'send-test-email', type: 'button', text: 'Send test email' }),
    ]),
    el('div', { id: 'email-check-result' }),
  );

  document.getElementById('send-test-email').addEventListener('click', async (event) => {
    const button = event.target;
    const target = document.getElementById('email-check-result');
    button.disabled = true;
    button.textContent = 'Sending…';
    target.innerHTML = '';
    try {
      const result = await api.post('/api/admin/test-email', {});
      notice(target, result.ok ? 'good' : 'warn', result.message);
      if (result.error) {
        target.append(el('p', { class: 'hint', style: 'margin-top:8px', text: `Provider said: ${result.error}` }));
      }
    } catch (error) {
      notice(target, 'bad', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Send test email';
    }
  });
}

function renderSummary(config, entries) {
  const source = entries.find((entry) => entry.key === 'venue_maximum')?.sourceNote;
  const tiles = [
    el('div', {}, [el('strong', { text: String(config.memberChannelCapacity) }), 'spots per hour']),
    el('div', {}, [el('strong', { text: String(config.maxGuestsPerMember) }), 'guests per member']),
    el('div', {}, [el('strong', { text: `$${config.guestPrice}` }), 'per guest, at the door']),
  ];
  if (config.venueMaximum !== null) {
    tiles.push(el('div', {}, [el('strong', { text: String(config.venueMaximum) }), 'venue ceiling']));
  }

  summaryEl.innerHTML = '';
  summaryEl.append(
    el('div', { class: 'totals' }, tiles),
    el('p', {
      class: 'hint',
      style: 'margin-top:14px',
      text:
        config.venueMaximum === null
          ? 'No venue-wide ceiling is enforced. Bookings are limited by the spots per hour above.'
          : `Venue ceiling source: ${source || 'not recorded'}`,
    }),
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
        : el('input', {
            id: spec.key,
            name: spec.key,
            type: 'text',
            inputmode: 'numeric',
            placeholder: spec.optional ? 'Leave blank for none' : '',
            value: value === null || value === undefined ? '' : String(value),
          });

    form.append(
      el('div', {}, [
        el('label', { for: spec.key, text: spec.label }),
        control,
        spec.hint ? el('p', { class: 'hint', text: spec.hint }) : null,
      ]),
    );
  }

  const waiver = config.waiverText ?? { clauses: [], declaration: '', termsUrl: '', version: '' };
  form.append(
    el('h2', { style: 'margin-bottom:4px', text: 'Guest waiver' }),
    el('p', { class: 'hint', style: 'margin-top:0', text: 'Shown to every guest before they visit. Changes take effect immediately. Bump the version whenever the wording changes: it is stamped on every signature, so which text a guest agreed to stays provable.' }),
    el('div', {}, [
      el('label', { for: 'waiver_version_field', text: 'Waiver version' }),
      el('input', { id: 'waiver_version_field', type: 'text', value: waiver.version ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_terms_url', text: 'Terms of Use link (the binding document)' }),
      el('input', { id: 'waiver_terms_url', type: 'text', value: waiver.termsUrl ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_clauses', text: 'Clauses, one per line as "Heading | text"' }),
      el('textarea', {
        id: 'waiver_clauses',
        rows: '10',
        style: 'width:100%;padding:11px 12px;font:inherit;border:1px solid var(--line);border-radius:8px',
      }, [(waiver.clauses ?? []).map((clause) => `${clause.heading} | ${clause.body}`).join('\n')]),
    ]),
    el('div', {}, [
      el('label', { for: 'waiver_declaration', text: 'Declaration the guest agrees to' }),
      el('input', { id: 'waiver_declaration', type: 'text', value: waiver.declaration ?? '' }),
    ]),
    el('div', {}, [
      el('label', { for: 'sourceNote', text: 'Documented source (required when setting a venue ceiling)' }),
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
    const raw = document.getElementById(spec.key).value.trim();
    let value;
    if (spec.type === 'select') {
      value = raw;
    } else if (spec.optional && raw === '') {
      value = null;
    } else {
      value = Number(raw);
      if (raw === '' || Number.isNaN(value)) {
        return notice(messages, 'warn', `${spec.label} must be a number.`);
      }
    }
    if (value !== current[spec.field]) updates[spec.key] = value;
  }

  // Waiver wording, edited as one clause per line: "Heading | body".
  const waiverBox = document.getElementById('waiver_clauses');
  if (waiverBox) {
    const clauses = waiverBox.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf('|');
        return split === -1
          ? { heading: '', body: line }
          : { heading: line.slice(0, split).trim(), body: line.slice(split + 1).trim() };
      });
    const next = {
      ...current.waiverText,
      clauses,
      termsUrl: document.getElementById('waiver_terms_url').value.trim(),
      declaration: document.getElementById('waiver_declaration').value.trim(),
      version: document.getElementById('waiver_version_field').value.trim(),
    };
    if (JSON.stringify(next) !== JSON.stringify(current.waiverText)) {
      updates.waiver_text = next;
      // The version is stamped on every signature, so keep the two in step.
      if (next.version !== current.waiverVersion) updates.waiver_version = next.version;
    }
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
