import { api, el, money, notice } from '/api.js';
import { mountSignIn } from '/signin.js';
import { mountAdminNav } from '/nav.js';

mountAdminNav();

/**
 * Door list. Built for a phone or a tablet held at a door: big touch targets,
 * one session at a time, no horizontal scrolling on the primary columns.
 *
 * Payment status here records what the EFTPOS terminal collected. It is a
 * reconciliation record, not a payment: no money moves through this software.
 */

const messages = document.getElementById('messages');
const signinCard = document.getElementById('signin-card');
const doorSection = document.getElementById('door-section');
const dateInput = document.getElementById('date');
const sessionSelect = document.getElementById('session');
const listEl = document.getElementById('list');
const totalsEl = document.getElementById('totals');
const staleEl = document.getElementById('stale');

const timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Australia/Perth' });

mountSignIn({
  formId: 'signin-form',
  buttonId: 'signin-button',
  emailId: 'email',
  passwordId: 'password',
  messages,
  onSignedIn: loadDay,
});

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date());
}

async function loadDay() {
  const date = dateInput.value || todayKey();
  dateInput.value = date;
  document.getElementById('csv').href = `/api/admin/reconciliation?date=${date}`;

  try {
    const data = await api.get(`/api/door/list?date=${encodeURIComponent(date)}`);
    signinCard.classList.add('hidden');
    doorSection.classList.remove('hidden');

    sessionSelect.innerHTML = '';
    if (data.sessions.length === 0) {
      sessionSelect.append(el('option', { value: '', text: 'No member-channel bookings on this day' }));
      listEl.innerHTML = '';
      totalsEl.classList.add('hidden');
      return;
    }

    for (const session of data.sessions) {
      sessionSelect.append(
        el('option', {
          value: session.externalSessionId,
          text: `${timeFormat.format(new Date(session.startsAt))} — ${session.bookings} booking${session.bookings === 1 ? '' : 's'}, ${session.spots} spots`,
        }),
      );
    }
    await loadSession();
  } catch (error) {
    if (error.code === 'UNAUTHENTICATED') {
      signinCard.classList.remove('hidden');
      doorSection.classList.add('hidden');
      return;
    }
    notice(messages, 'bad', error.message);
  }
}

async function loadSession() {
  const sessionId = sessionSelect.value;
  if (!sessionId) return;

  try {
    const { doorList } = await api.get(`/api/door/list?session=${encodeURIComponent(sessionId)}`);
    renderTotals(doorList);
    renderStale(doorList);
    renderRows(doorList);
  } catch (error) {
    notice(messages, 'bad', error.message);
  }
}

function renderStale(doorList) {
  staleEl.innerHTML = '';
  if (!doorList.membershipStaleSince) return;
  const ageMinutes = Math.round((Date.now() - new Date(doorList.membershipStaleSince)) / 60000);
  // Only worth flagging once it is old enough to matter at a door.
  if (ageMinutes < 120) return;
  notice(
    staleEl,
    'warn',
    `Membership details were last synced ${Math.round(ageMinutes / 60)} hours ago. If someone's status looks wrong, check it in Hapana before turning them away.`,
  );
}

function renderTotals(doorList) {
  totalsEl.classList.remove('hidden');
  totalsEl.innerHTML = '';
  const totals = doorList.totals;
  totalsEl.append(
    el('div', { class: 'totals' }, [
      el('div', {}, [el('strong', { text: String(totals.spots) }), 'spots']),
      el('div', {}, [el('strong', { text: String(totals.guests) }), 'guests']),
      el('div', {}, [el('strong', { text: money(totals.owed) }), 'owed']),
      el('div', {}, [el('strong', { text: money(totals.collected) }), 'collected']),
      el('div', {}, [el('strong', { text: money(totals.outstanding) }), 'outstanding']),
      el('div', {}, [el('strong', { text: String(totals.waiversUnsigned) }), 'waivers unsigned']),
    ]),
  );
}

function renderRows(doorList) {
  listEl.innerHTML = '';
  if (doorList.rows.length === 0) {
    listEl.append(el('p', { class: 'muted', text: 'No member-channel bookings for this session.' }));
    return;
  }

  const body = el('tbody');
  for (const row of doorList.rows) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          el('strong', { text: row.memberName }),
          el('div', { class: 'muted', text: `${row.spots} spot${row.spots === 1 ? '' : 's'}` }),
        ]),
        el('td', { text: row.amountOwed > 0 ? money(row.amountOwed) : '—' }),
        el('td', {}, [
          el('button', {
            class: row.paymentStatus === 'collected' ? 'btn-primary btn-small' : 'btn-quiet btn-small',
            type: 'button',
            text: row.paymentStatus === 'collected' ? 'Collected' : 'Mark collected',
            disabled: row.amountOwed === 0,
            onclick: () => setPayment(row, row.paymentStatus === 'collected' ? 'outstanding' : 'collected'),
          }),
        ]),
        el('td', {}, [
          el('button', {
            class: row.memberCheckedIn ? 'btn-primary btn-small' : 'btn-quiet btn-small',
            type: 'button',
            text: row.memberCheckedIn ? 'In' : 'Check in',
            onclick: () => setCheckIn({ bookingId: row.bookingId }, !row.memberCheckedIn),
          }),
        ]),
      ]),
    );

    for (const guest of row.guests) {
      body.append(
        el('tr', { class: 'guest-row' }, [
          el('td', { text: guest.name }),
          el('td', {}, [waiverPill(guest, row)]),
          el('td', { text: '' }),
          el('td', {}, [
            el('button', {
              class: guest.checkedIn ? 'btn-primary btn-small' : 'btn-quiet btn-small',
              type: 'button',
              text: guest.checkedIn ? 'In' : 'Check in',
              onclick: () => setCheckIn({ guestId: guest.guestId }, !guest.checkedIn),
            }),
          ]),
        ]),
      );
    }
  }

  listEl.append(
    el('div', { class: 'card scroll-x' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Member and guests' }),
            el('th', { text: 'Owed / waiver' }),
            el('th', { text: 'Payment' }),
            el('th', { text: 'Arrived' }),
          ]),
        ]),
        body,
      ]),
    ]),
  );
}

function waiverPill(guest, row) {
  if (guest.waiverStatus === 'signed') return el('span', { class: 'pill pill--good', text: 'Waiver signed' });
  // Unsigned never blocks entry, so this is an action rather than a warning:
  // hand the tablet over and the guest signs on the spot. This is also the
  // path that works when no email provider is configured and the waiver was
  // never delivered.
  return el('button', {
    class: 'btn-quiet btn-small',
    type: 'button',
    text: 'Sign waiver',
    onclick: () => openWaiver(row.bookingId, guest),
  });
}

/**
 * Opens a guest's waiver on this device so they can sign at the door. A fresh
 * token is minted each time, which invalidates any older link for that guest:
 * the waiver stays one document with one signature history.
 */
async function openWaiver(bookingId, guest) {
  try {
    const result = await api.post('/api/staff/links', { action: 'guest-waiver', bookingId, guestId: guest.guestId });
    window.open(result.url, '_blank', 'noopener');
  } catch (error) {
    notice(messages, 'bad', error.message);
  }
}

async function setPayment(row, paymentStatus) {
  try {
    await api.post('/api/door/update', { bookingId: row.bookingId, paymentStatus });
    await loadSession();
  } catch (error) {
    notice(messages, 'bad', error.message);
  }
}

async function setCheckIn(target, checkedIn) {
  try {
    await api.post('/api/door/update', { ...target, checkedIn });
    await loadSession();
  } catch (error) {
    notice(messages, 'bad', error.message);
  }
}

dateInput.value = todayKey();
dateInput.addEventListener('change', loadDay);
sessionSelect.addEventListener('change', loadSession);
document.getElementById('refresh').addEventListener('click', loadDay);
loadDay();
