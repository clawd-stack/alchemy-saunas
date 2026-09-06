import { api, el, money, notice } from '/api.js';
import { mountFirstTime, mountSignIn } from '/signin.js';
import { mountNav } from '/nav.js';
import { renderMyBookings } from '/bookings-list.js';

// Held, because the header has to be redrawn after signing in. It is built
// from /api/auth/session at page load, which on the sign-in screen is a
// signed-out answer: without this, "My account" only appeared on the next
// page load, and the member's own name never appeared at all until they
// reloaded.
const nav = mountNav();

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
const monthEl = document.getElementById('month');
const slotsEl = document.getElementById('slots');
const slotsEmpty = document.getElementById('slots-empty');
const guestCard = document.getElementById('guest-card');
const guestFields = document.getElementById('guest-fields');
const amountEl = document.getElementById('amount');
const guestCountEl = document.getElementById('guest-count');
const selectedLabel = document.getElementById('selected-label');
const selectedDetail = document.getElementById('selected-detail');
const dayHeadingEl = document.getElementById('day-heading');
const myBookings = document.getElementById('my-bookings');

const state = {
  policy: { maxGuests: 3, guestPrice: 35, cancellationCutoffHours: 3, bookingWindowDays: 14, sessionLengthMinutes: 60 },
  timezone: 'Australia/Perth',
  venueName: 'Alchemy East Fremantle',
  venueAddress: '',
  sessions: [],
  selectedDay: null,
  selectedSession: null,
  guests: [],
  signedIn: false,
};

const dayFormat = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: 'Australia/Perth' });
const domFormat = new Intl.DateTimeFormat('en-AU', { day: 'numeric', timeZone: 'Australia/Perth' });
const monthFormat = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Perth' });
const timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Australia/Perth' });
const dayHeadingFormat = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Australia/Perth' });

/**
 * How long a session runs. Taken from the session itself where the timetable
 * gives an end, so a one-off longer session reads as what it is rather than as
 * whatever the default happens to be.
 */
function durationLabel(session) {
  const minutes = session.endsAt
    ? Math.round((new Date(session.endsAt) - new Date(session.startsAt)) / 60000)
    : state.policy.sessionLengthMinutes;
  if (!minutes || minutes < 1) return '';
  return minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

function dayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: state.timezone }).format(new Date(iso));
}

/* ---------------------------------------------------------------- */
/* Sign in                                                           */
/* ---------------------------------------------------------------- */

const afterSignIn = async () => {
  await loadSessions();
  nav?.refresh();
};

mountSignIn({
  formId: 'signin-form',
  buttonId: 'signin-button',
  emailId: 'email',
  passwordId: 'password',
  messages,
  onSignedIn: afterSignIn,
});

// A member who has never been here has no password to sign in with, and
// nobody is going to issue four hundred of them by hand.
mountFirstTime({ messages, onSignedIn: afterSignIn });

/* ---------------------------------------------------------------- */
/* Sessions                                                          */
/* ---------------------------------------------------------------- */

async function loadSessions() {
  try {
    const data = await api.get('/api/sessions');
    state.policy = { ...state.policy, ...data.policy };
    state.timezone = data.venue.timezone;
    state.venueName = data.venue.name ?? state.venueName;
    state.venueAddress = data.venue.address ?? '';
    state.sessions = data.sessions;
    state.signedIn = data.signedIn;

    // Somewhere to write when the screen cannot help, under the form rather
    // than inside it: a member who cannot get in is the one who most needs it
    // and the one the form has nothing left to offer.
    const support = document.getElementById('support');
    if (support) {
      support.innerHTML = '';
      if (data.supportEmail && !data.signedIn) {
        support.append(
          'Trouble signing in? ',
          el('a', { href: `mailto:${data.supportEmail}`, text: 'Email us' }),
        );
      }
      support.hidden = !data.supportEmail || data.signedIn;
    }

    // Exactly one of the two states goes up. Before this, the form was
    // markup's default and flashed at every signed-in member on every load.
    signinCard.classList.toggle('hidden', data.signedIn);
    bookingSection.classList.toggle('hidden', !data.signedIn);
    document.getElementById('heading').textContent = data.signedIn ? 'Book a session' : 'Member booking';

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
  } finally {
    // Down whatever happened: an outage that left a spinner spinning forever
    // would read as a hung page rather than as the error beside it.
    document.getElementById('page-loading')?.setAttribute('hidden', '');
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

  // The month sits above the strip rather than inside every tile: it is the
  // same word on almost every one, and repeating it forced the tiles wider
  // than the row could show.
  const selectedFirst = byDay.get(state.selectedDay)?.[0];
  monthEl.textContent = selectedFirst ? monthFormat.format(new Date(selectedFirst.startsAt)) : '';

  daysEl.innerHTML = '';
  for (const key of keys) {
    const first = byDay.get(key)[0];
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
        el('span', { class: 'dow', text: dayFormat.format(new Date(first.startsAt)) }),
        el('span', { class: 'dom', text: domFormat.format(new Date(first.startsAt)) }),
      ]),
    );
  }

  renderSlots(byDay.get(state.selectedDay) ?? []);
}

function renderSlots(sessions) {
  slotsEl.innerHTML = '';
  slotsEmpty.hidden = sessions.length > 0;

  const first = sessions[0];
  dayHeadingEl.textContent = first ? dayHeadingFormat.format(new Date(first.startsAt)) : '';
  dayHeadingEl.hidden = !first;

  for (const session of sessions) {
    const selected = state.selectedSession?.externalSessionId === session.externalSessionId;
    const spots = session.spotsRemaining;
    slotsEl.append(
      el('button', {
        class: 'session',
        type: 'button',
        disabled: !session.bookable,
        'aria-pressed': String(selected),
        onclick: () => selectSession(session),
      }, [
        el('span', { class: 'session__when' }, [
          el('span', { class: 'session__time', text: timeFormat.format(new Date(session.startsAt)) }),
          el('span', { class: 'session__length', text: durationLabel(session) }),
          // Only when there is something left to say: the button already
          // reads "full" and saying it twice in one row is noise.
          spots > 0 ? el('span', { class: 'session__spots', text: `${spots} left` }) : null,
        ]),
        el('span', { class: 'session__what' }, [
          el('span', { class: 'session__title', text: 'Member session' }),
          el('span', { class: 'session__where', text: state.venueName }),
        ]),
        // The word the app puts here, and the one a member is looking for.
        el('span', {
          class: 'session__cta',
          text: !session.bookable ? 'Full' : selected ? 'Selected' : 'Book',
        }),
      ]),
    );
  }
}

function selectSession(session) {
  state.selectedSession = session;
  state.guests = [];
  guestCard.classList.remove('hidden');
  const at = new Date(session.startsAt);
  selectedLabel.textContent =
    `${dayFormat.format(at)} ${domFormat.format(at)} ${monthFormat.format(at).split(' ')[0]}, ${timeFormat.format(at)}`;

  // What a member wants to know before confirming: where it is and how long
  // they are committing to. Both were only ever on the confirmation email.
  const length = durationLabel(session);
  selectedDetail.textContent = [
    state.venueAddress,
    length ? `${length} session` : '',
  ].filter(Boolean).join(' · ');
  selectedDetail.hidden = !selectedDetail.textContent;
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
        el('div', { style: 'margin-top:16px' }, [
          el('label', { for: `guest-name-${index}`, text: 'Name' }),
          el('input', {
            id: `guest-name-${index}`, type: 'text', value: guest.name, autocomplete: 'off',
            oninput: (event) => { state.guests[index].name = event.target.value; updateTotals(); },
          }),
        ]),
        el('div', { style: 'margin-top:16px' }, [
          el('label', { for: `guest-email-${index}`, text: 'Email' }),
          el('input', {
            id: `guest-email-${index}`, type: 'email', value: guest.email, autocomplete: 'off',
            oninput: (event) => { state.guests[index].email = event.target.value; updateTotals(); },
          }),
        ]),
      ]),
    );
  });
  updateTotals();
}

function updateTotals() {
  const max = maxGuestsNow();
  amountEl.textContent = money(state.guests.length * state.policy.guestPrice);
  guestCountEl.textContent = max === 0 ? 'No guest spots left' : `${state.guests.length} of ${max}`;
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
    button.textContent = 'Confirm';
  }
});

/* ---------------------------------------------------------------- */
/* My bookings                                                       */
/* ---------------------------------------------------------------- */

async function loadMyBookings() {
  await renderMyBookings(myBookings, { messages, onChanged: loadSessions });
}

loadSessions();

