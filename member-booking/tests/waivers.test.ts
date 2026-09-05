import { describe, expect, it } from 'vitest';
import { createBooking, cancelBooking } from '../src/domain/booking.ts';
import { getWaiverByToken, sendWaiverReminders, signWaiver } from '../src/domain/waivers.ts';
import { normaliseSignature } from '../src/lib/signature.ts';
import { guests, makeHarness } from './helpers.ts';

/** A short scribble in the coordinate space the pad writes out. */
const SIGNATURE = 'M120 260L240 140L300 280L420 130L520 250';

const MEMBER = { memberId: 'mem-1', email: 'member1@example.com', name: 'Member One' };

/** Extracts the token a waiver email carried, the way a guest's inbox would. */
function tokenFromWaiverEmail(url: string): string {
  return new URL(url).hash.slice(1);
}

describe('waivers (PRD 5.4)', () => {
  it('emails every guest their own waiver at their own address', async () => {
    const { context, store, session } = makeHarness();
    await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(2) });

    const invites = store.outboxAll().filter((entry) => entry.template === 'waiver_invite');
    expect(invites.map((entry) => entry.toEmail).sort()).toEqual(['guest1@example.com', 'guest2@example.com']);
    // The member does not sign on a guest's behalf, so nothing goes to them.
    expect(invites.some((entry) => entry.toEmail === MEMBER.email)).toBe(false);
  });

  it('does not block the booking when a waiver is unsigned', async () => {
    const { context, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });
    expect(booking.status).toBe('confirmed');
    expect(booking.guests[0]?.waiverStatus).toBe('sent');
  });

  it('records the signature with a timestamp and shows it on the booking', async () => {
    const { context, store, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });

    const waivers = await store.waivers.listForBooking(booking.bookingId);
    expect(waivers).toHaveLength(1);

    // The raw token is only in the email; the store keeps a hash.
    const invite = store.outboxAll().find((entry) => entry.template === 'waiver_invite');
    expect(invite).toBeDefined();

    // Sign through the same path the page uses.
    const waiverId = waivers[0]!.waiverId;
    const signed = await store.waivers.sign({
      waiverId, signedName: 'Guest One', signature: SIGNATURE, ip: null, userAgent: null,
    });
    expect(signed?.status).toBe('signed');
    expect(signed?.signedAt).not.toBeNull();
    expect(signed?.signature).toBe(SIGNATURE);

    const refreshed = await store.bookings.get(booking.bookingId);
    expect(refreshed?.guests[0]?.waiverStatus).toBe('signed');
  });

  it('keeps the signed waiver after the booking is cancelled', async () => {
    const { context, store, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });
    const waivers = await store.waivers.listForBooking(booking.bookingId);
    await store.waivers.sign({
      waiverId: waivers[0]!.waiverId, signedName: 'Guest One', signature: SIGNATURE, ip: null, userAgent: null,
    });

    await cancelBooking(context, MEMBER.memberId, booking.bookingId);

    // The liability record survives: PRD 5.4.
    const after = await store.waivers.listForBooking(booking.bookingId);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('signed');
    expect(after[0]?.signedAt).not.toBeNull();
  });
});

describe('waiver reminders', () => {
  it('sends one reminder 24 hours out, and only one however often the job runs', async () => {
    const { context, store, session } = makeHarness({ sessionHoursAhead: 24 });
    await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });

    expect(await sendWaiverReminders(context)).toBe(1);
    expect(await sendWaiverReminders(context)).toBe(0);

    const reminders = store.outboxAll().filter((entry) => entry.template === 'waiver_reminder');
    expect(reminders).toHaveLength(1);
  });

  it('sends a reminder link that actually resolves', async () => {
    const { context, store, session } = makeHarness({ sessionHoursAhead: 24 });
    await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });
    await sendWaiverReminders(context);

    // Rotating the token is what makes this possible: the original was only
    // ever stored as a hash, so it could not have been re-sent.
    const reminder = store.outboxAll().find((entry) => entry.template === 'waiver_reminder');
    const payloadUrl = String((reminder?.payload as Record<string, unknown>).subject ?? '');
    expect(payloadUrl).toContain('Reminder');

    const waivers = await store.waivers.listForBooking(
      (await store.bookings.listForMember(MEMBER.memberId, new Date(0)))[0]!.bookingId,
    );
    expect(waivers[0]?.reminderSentAt).not.toBeNull();
  });

  it('does not chase a guest whose spot was cancelled', async () => {
    const { context, session } = makeHarness({ sessionHoursAhead: 24 });
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(1) });
    await cancelBooking(context, MEMBER.memberId, booking.bookingId);
    expect(await sendWaiverReminders(context)).toBe(0);
  });
});

describe('waiver token handling', () => {
  it('rejects a token that was never issued', async () => {
    const { context } = makeHarness();
    expect(await getWaiverByToken(context, 'a'.repeat(40))).toBeNull();
    expect(await signWaiver(context, {
      token: 'a'.repeat(40), signedName: 'X', signature: SIGNATURE, ip: null, userAgent: null,
    })).toBeNull();
  });

  it('rejects an obviously malformed token without a lookup', async () => {
    const { context } = makeHarness();
    expect(await getWaiverByToken(context, 'short')).toBeNull();
  });
});

/**
 * BookingError keeps the generic wording on Error.message and the wording the
 * guest actually sees on userMessage, so that is what these assert.
 */
function refusalFor(value: unknown): { code: string; userMessage: string } {
  try {
    normaliseSignature(value);
  } catch (error) {
    return error as unknown as { code: string; userMessage: string };
  }
  throw new Error(`expected ${JSON.stringify(value)} to be refused`);
}

describe('the drawn signature', () => {
  it('keeps a scribble as it was drawn', () => {
    expect(normaliseSignature(SIGNATURE)).toBe(SIGNATURE);
    expect(normaliseSignature(`  ${SIGNATURE}  `)).toBe(SIGNATURE);
  });

  it('refuses a single tap, which is a smudge rather than a signature', () => {
    expect(refusalFor('M120 260').userMessage).toMatch(/sign in the box/i);
  });

  it('refuses an empty box', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      expect(refusalFor(value).userMessage).toMatch(/sign in the box/i);
    }
  });

  it('refuses anything that is not the two path commands and numbers', () => {
    // Nothing here can reach a page as markup, because nothing but digits,
    // spaces, M and L survives.
    for (const value of [
      'M0 0L1 1"/><script>alert(1)</script>',
      '<svg onload=alert(1)>',
      'M0 0Z',
      'M0 0L1 1 z',
      'M-5 0L1 1',
      'M0.5 0L1 1',
    ]) {
      expect(refusalFor(value).code, String(value)).toBe('INVALID_REQUEST');
    }
  });

  it('refuses a path longer than any real signature', () => {
    const long = `M0 0${'L1 1'.repeat(5000)}`;
    expect(refusalFor(long).code).toBe('INVALID_REQUEST');
  });
});
