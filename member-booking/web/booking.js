import { api, el, money, notice } from '/api.js';
import { mountSignIn } from '/signin.js';
import { mountNav } from '/nav.js';

mountNav();

/**
 * Member booking front end.
 *
 * Presentation only. Every rule that matters, membership, allocation and the
 * venue ceiling, is enforced in the API layer: this page's job is to make the
 * common path quick and to report refusals in plain language. It never assumes
 * a spot is available because the UI said so, so a session filling up between
 * page load and confirm is handled, not crashed on.
 */

const messages = document.getElementById('messages');
const signinCard = document.getElementById('signin-card');
const bookingSection = document.getElementById('booking-section');
const daysEl = document.getElementById('days');
const slotsEl = document.getElementById('slots');
const slotsEmpty = document.getElementById('slots-empty');
const guestCard = document.getElementById('guest-card');
const guestFields = document.getElementById('guest-fields');
const amountEl = document.getElementById('amount');
const guestCountEl = document.getElementById('guest-count');
const selectedLabel = document.getElementById('selected-label');
const policyNote = document.getElementById('policy-note');
const myBookings = document.getElementById('my-bookings');

const state = {
  policy: { maxGuests: 3, guestPrice: 35, cancellationCutoffHours: 3, bookingWindowDays: 14 },
  timezone: 'Australia/Perth',
  sessions: [],
  selectedDay: null,
  selectedSession: null,
  guests: [],
  signedIn: false,
};

const dayFormat = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: 'Australia/Perth' });
const domFormat = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Perth' });
const timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Australia/Perth' });

function dayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: state.timezone }).format(new Date(iso));
}

/* ---------------------------------------------------------------- */
/* Sign in                                                           */
/* ---------------------------------------------------------------- */

mountSignIn({
  formId: 'signin-form',
  buttonId: 'signin-button',
  emailId: 'email',
  passwordId: 'password',
  messages,
  onSignedIn: loadSessions,
});

document.getElementById('signout').addEventListener('click', async () => {
  await api.post('/api/auth/session', {});
  location.href = '/booking.html';
});

/* ---------------------------------------------------------------- */
/* Sessions                                                          */
/* ---------------------------------------------------------------- */

async function loadSessions() {
  try {
    const data = await api.get('/api/sessions');
    state.policy = data.policy;
    state.timezone = data.venue.timezone;
    state.sessions = data.sessions;
    state.signedIn = data.signedIn;

    document.getElementById('member-name').textContent = data.memberName ?? '';
    signinCard.classList.toggle('hidden', data.signedIn);
    bookingSection.classList.toggle('hidden', !data.signedIn);
    policyNote.textContent =
      `Free cancellation up to ${state.policy.cancellationCutoffHours} hours before the session starts. ` +
      `Guest spots are ${money(state.policy.guestPrice)} each, collected by card at the venue.`;

    renderDays();
    if (data.signedIn) loadMyBookings();
  } catch (error) {
    // A backend outage must read as maintenance, not as an empty timetable
    // that looks like a sold-out venue.
    if (error.code === 'BACKEND_UNAVAILABLE' || error.code === 'OCCUPANCY_UNKNOWN') {
      notice(messages, 'warn', 'Bookings are briefly unavailable while our system reconnects. Please try again in a few minutes.');
      daysEl.innerHTML = '';
      slotsEl.innerHTML = '';
    } else {
      notice(messages, 'bad', error.message);
    }
  }
}

function renderDays() {
  const byDay = new Map();
  for (const session of state.sessions) {
    const key = dayKey(session.startsAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(session);
  }

  const keys = [...byDay.keys()].sort();
  if (!state.selectedDay || !byDay.has(state.selectedDay)) {
    state.selectedDay = keys.find((key) => byDay.get(key).some((s) => s.bookable)) ?? keys[0] ?? null;
  }

  daysEl.innerHTML = '';
  for (const key of keys) {
    const first = byDay.get(key)[0];
    const open = byDay.get(key).filter((s) => s.bookable).length;
    daysEl.append(
      el('button', {
        class: 'day',
        type: 'button',
        'aria-pressed': String(key === state.selectedDay),
        onclick: () => {
          state.selectedDay = key;
          state.selectedSession = null;
          guestCard.classList.add('hidden');
          renderDays();
        },
      }, [
        el('div', { class: 'dow', text: dayFormat.format(new Date(first.startsAt)) }),
        el('div', { class: 'dom', text: domFormat.format(new Date(first.startsAt)) }),
        el('div', { class: 'left', text: open > 0 ? `${open} times` : 'full' }),
      ]),
    );
  }

  renderSlots(byDay.get(state.selectedDay) ?? []);
}

function renderSlots(sessions) {
  slotsEl.innerHTML = '';
  slotsEmpty.hidden = sessions.length > 0;

  for (const session of sessions) {
    const selected = state.selectedSession?.externalSessionId === session.externalSessionId;
    slotsEl.append(
      el('button', {
        class: 'slot',
        type: 'button',
        disabled: !session.bookable,
        'aria-pressed': String(selected),
        onclick: () => selectSession(session),
      }, [
        el('div', { class: 'time', text: timeFormat.format(new Date(session.startsAt)) }),
        el('div', {
          class: 'left',
          text: session.spotsRemaining > 0 ? `${session.spotsRemaining} of ${session.capacity} left` : 'Full',
        }),
      ]),
    );
  }
}

function selectSession(session) {
  state.selectedSession = session;
  state.guests = [];
  guestCard.classList.remove('hidden');
  selectedLabel.textContent =
    `${dayFormat.format(new Date(session.startsAt))} ${domFormat.format(new Date(session.startsAt))}, ` +
    `${timeFormat.format(new Date(session.startsAt))}. ${session.spotsRemaining} spots left.`;
  renderDays();
  renderGuests();
  guestCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------------------------------------------------------- */
/* Guests                                                            */
/* ---------------------------------------------------------------- */

function maxGuestsNow() {
  const remaining = (state.selectedSession?.spotsRemaining ?? 1) - 1;
  return Math.max(0, Math.min(state.policy.maxGuests, remaining));
}

function renderGuests() {
  guestFields.innerHTML = '';
  state.guests.forEach((guest, index) => {
    guestFields.append(
      el('div', { class: 'card', style: 'margin:0' }, [
        el('div', { class: 'row row--between' }, [
          el('strong', { text: `Guest ${index + 1}` }),
          el('button', {
            class: 'btn-quiet btn-small', type: 'button', text: 'Remove',
            onclick: () => { state.guests.splice(index, 1); renderGuests(); },
          }),
        ]),
        el('div', { style: 'margin-top:10px' }, [
          el('label', { for: `guest-name-${index}`, text: 'Full name' }),
          el('input', {
            id: `guest-name-${index}`, type: 'text', value: guest.name, autocomplete: 'off',
            oninput: (event) => { state.guests[index].name = event.target.value; updateTotals(); },
          }),
        ]),
        el('div', { style: 'margin-top:10px' }, [
          el('label', { for: `guest-email-${index}`, text: 'Email' }),
          el('input', {
            id: `guest-email-${index}`, type: 'email', value: guest.email, autocomplete: 'off',
            oninput: (event) => { state.guests[index].email = event.target.value; updateTotals(); },
          }),
          el('p', { class: 'hint', text: 'Their waiver goes to this address. Each guest signs their own.' }),
        ]),
      ]),
    );
  });
  updateTotals();
}

function updateTotals() {
  const max = maxGuestsNow();
  amountEl.textContent = money(state.guests.length * state.policy.guestPrice);
  guestCountEl.textContent =
    max === 0
      ? 'No room for guests in this session.'
      : `${state.guests.length} of ${max} guest spots used.`;
  document.getElementById('add-guest').disabled = state.guests.length >= max;
}

document.getElementById('add-guest').addEventListener('click', () => {
  if (state.guests.length >= maxGuestsNow()) return;
  state.guests.push({ name: '', email: '' });
  renderGuests();
});

/* ---------------------------------------------------------------- */
/* Confirm                                                           */
/* ---------------------------------------------------------------- */

document.getElementById('confirm').addEventListener('click', async () => {
  if (!state.selectedSession) return;
  const button = document.getElementById('confirm');
  button.disabled = true;
  button.textContent = 'Booking…';

  try {
    const result = await api.post('/api/bookings', {
      sessionId: state.selectedSession.externalSessionId,
      guests: state.guests,
    });
    notice(messages, 'good', `${result.sessionLabel}. ${result.message}`);
    state.selectedSession = null;
    state.guests = [];
    guestCard.classList.add('hidden');
    await loadSessions();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    notice(messages, error.code === 'SESSION_FULL' || error.code === 'VENUE_CEILING' ? 'warn' : 'bad', error.message);
    // The session may have filled while the form was open, so re-read rather
    // than leaving stale availability on screen.
    if (['SESSION_FULL', 'VENUE_CEILING', 'SESSION_NOT_FOUND', 'ALREADY_BOOKED'].includes(error.code)) {
      await loadSessions();
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Confirm booking';
  }
});

/* ---------------------------------------------------------------- */
/* My bookings                                                       */
/* ---------------------------------------------------------------- */

async function loadMyBookings() {
  try {
    const data = await api.get('/api/bookings');
    const live = data.bookings.filter((booking) => booking.status === 'confirmed');
    myBookings.innerHTML = '';

    if (live.length === 0) {
      myBookings.append(el('p', { class: 'muted', text: 'Nothing booked yet.' }));
      return;
    }

    for (const booking of live) {
      const guests = booking.guests.filter((guest) => guest.status === 'confirmed');
      myBookings.append(
        el('div', { class: 'card' }, [
          el('div', { class: 'row row--between' }, [
            el('div', {}, [
              el('strong', { text: booking.sessionLabel }),
              el('p', { class: 'muted', style: 'margin:4px 0 0', text: `${booking.spotsTotal} spot${booking.spotsTotal === 1 ? '' : 's'}${guests.length ? `, with ${guests.map((g) => g.name).join(', ')}` : ''}` }),
              booking.amountOwedAud > 0
                ? el('p', { class: 'muted', style: 'margin:4px 0 0', text: `${money(booking.amountOwedAud)} to pay by card at the venue.` })
                : null,
            ]),
            booking.canCancel
              ? el('button', {
                  class: 'btn-danger btn-small', type: 'button', text: 'Cancel',
                  onclick: () => cancelBooking(booking.bookingId),
                })
              : el('span', { class: 'pill pill--quiet', text: 'Cancellation closed' }),
          ]),
          guests.length
            ? el('p', { class: 'hint', style: 'margin-top:12px', text: guests.map((g) => `${g.name}: waiver ${g.waiverStatus === 'signed' ? 'signed' : 'not signed yet'}`).join(' · ') })
            : null,
        ]),
      );
    }
  } catch (error) {
    myBookings.innerHTML = '';
    myBookings.append(el('p', { class: 'muted', text: error.message }));
  }
}

async function cancelBooking(bookingId) {
  if (!confirm('Cancel this booking? Any guest spots are cancelled too, and your guests will be emailed.')) return;
  try {
    const result = await api.post('/api/bookings/cancel', { bookingId });
    notice(messages, 'good', result.message);
    await loadSessions();
  } catch (error) {
    notice(messages, 'warn', error.message);
  }
}

loadSessions();
