import { formatLocal, localDateKey, localWallClockToInstant } from '../lib/time.ts';
import type { Context } from './context.ts';
import type { BookingRecord } from '../store/types.ts';

/**
 * Door list and reconciliation, PRD 5.6 and 6.
 *
 * Payment status here is a record for reconciling against the EFTPOS terminal,
 * not a payment integration. No money moves through this software.
 */

export interface DoorListGuest {
  guestId: string;
  name: string;
  waiverStatus: 'not_sent' | 'sent' | 'signed';
  waiverSignedAt: string | null;
  checkedIn: boolean;
}

export interface DoorListRow {
  bookingId: string;
  memberName: string;
  memberEmail: string;
  spots: number;
  amountOwed: number;
  paymentStatus: 'outstanding' | 'collected' | 'waived';
  memberCheckedIn: boolean;
  guests: DoorListGuest[];
}

export interface DoorList {
  venueId: string;
  venueName: string;
  sessionId: string;
  sessionLabel: string;
  startsAt: string;
  rows: DoorListRow[];
  totals: {
    bookings: number;
    spots: number;
    guests: number;
    owed: number;
    collected: number;
    outstanding: number;
    waiversUnsigned: number;
  };
  /**
   * Set under Pattern B when membership was last synced some time ago. Staff
   * need to know when the status they are trusting is stale. PRD 8.
   */
  membershipStaleSince: string | null;
}

export async function buildDoorList(
  context: Context,
  externalSessionId: string,
): Promise<DoorList> {
  const bookings = await context.store.bookings.listForSession(context.venueId, externalSessionId);
  const rows = bookings.filter((b) => b.status === 'confirmed').map(toRow);
  const startsAt = bookings[0]?.startsAt ?? '';

  return {
    venueId: context.venueId,
    venueName: context.venueName,
    sessionId: externalSessionId,
    sessionLabel: startsAt ? formatLocal(startsAt, context.timezone) : externalSessionId,
    startsAt,
    rows,
    totals: totalsFor(rows),
    membershipStaleSince:
      context.config.bookingBackend === 'hapana' ? null : await context.store.members.lastSyncAt(),
  };
}

/** Every session on one local day, for the door tablet's session picker. */
export async function listSessionsForDay(
  context: Context,
  dateKey: string,
): Promise<Array<{ externalSessionId: string; sessionLabel: string; startsAt: string; bookings: number; spots: number }>> {
  const from = localWallClockToInstant(dateKey, '00:00', context.timezone);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const bookings = await context.store.bookings.listForVenueBetween(context.venueId, from, to);

  const grouped = new Map<string, { startsAt: string; bookings: number; spots: number }>();
  for (const booking of bookings) {
    if (booking.status !== 'confirmed') continue;
    const entry = grouped.get(booking.externalSessionId) ?? { startsAt: booking.startsAt, bookings: 0, spots: 0 };
    entry.bookings += 1;
    entry.spots += booking.spotsTotal;
    grouped.set(booking.externalSessionId, entry);
  }

  return [...grouped.entries()]
    .map(([externalSessionId, entry]) => ({
      externalSessionId,
      sessionLabel: formatLocal(entry.startsAt, context.timezone),
      startsAt: entry.startsAt,
      bookings: entry.bookings,
      spots: entry.spots,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function toRow(booking: BookingRecord): DoorListRow {
  return {
    bookingId: booking.bookingId,
    memberName: booking.memberName,
    memberEmail: booking.memberEmail,
    spots: booking.spotsTotal,
    amountOwed: booking.amountOwedAud,
    paymentStatus: booking.paymentStatus,
    memberCheckedIn: booking.memberCheckedIn,
    guests: booking.guests
      .filter((guest) => guest.status === 'confirmed')
      .map((guest) => ({
        guestId: guest.guestId,
        name: guest.name,
        waiverStatus: guest.waiverStatus,
        waiverSignedAt: guest.waiverSignedAt,
        checkedIn: guest.checkedIn,
      })),
  };
}

function totalsFor(rows: DoorListRow[]): DoorList['totals'] {
  return rows.reduce(
    (totals, row) => {
      totals.bookings += 1;
      totals.spots += row.spots;
      totals.guests += row.guests.length;
      totals.owed += row.amountOwed;
      if (row.paymentStatus === 'collected') totals.collected += row.amountOwed;
      else if (row.paymentStatus === 'outstanding') totals.outstanding += row.amountOwed;
      totals.waiversUnsigned += row.guests.filter((g) => g.waiverStatus !== 'signed').length;
      return totals;
    },
    { bookings: 0, spots: 0, guests: 0, owed: 0, collected: 0, outstanding: 0, waiversUnsigned: 0 },
  );
}

/**
 * Daily reconciliation CSV, PRD 6.
 *
 * With EFTPOS at the door and no payment integration, this is the only control
 * against guest revenue leaking. It lists what was owed against what was marked
 * collected, so the venue can tie it back to the terminal settlement.
 */
export async function reconciliationCsv(
  context: Context,
  dateKey: string,
): Promise<{ filename: string; csv: string }> {
  const from = localWallClockToInstant(dateKey, '00:00', context.timezone);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const bookings = await context.store.bookings.listForVenueBetween(context.venueId, from, to);

  const header = [
    'date',
    'session_start_local',
    'booking_id',
    'member_name',
    'member_email',
    'status',
    'spots_total',
    'guest_spots',
    'guest_names',
    'amount_owed_aud',
    'payment_status',
    'amount_collected_aud',
    'guests_checked_in',
    'waivers_signed',
    'waivers_outstanding',
  ];

  const lines = [header.join(',')];
  let owed = 0;
  let collected = 0;

  for (const booking of bookings) {
    const liveGuests = booking.guests.filter((g) => g.status === 'confirmed');
    const signed = liveGuests.filter((g) => g.waiverStatus === 'signed').length;
    const amountCollected = booking.status === 'confirmed' && booking.paymentStatus === 'collected' ? booking.amountOwedAud : 0;
    if (booking.status === 'confirmed') {
      owed += booking.amountOwedAud;
      collected += amountCollected;
    }
    lines.push(
      [
        dateKey,
        formatLocal(booking.startsAt, context.timezone),
        booking.bookingId,
        booking.memberName,
        booking.memberEmail,
        booking.status,
        booking.spotsTotal,
        liveGuests.length,
        liveGuests.map((g) => g.name).join('; '),
        booking.amountOwedAud.toFixed(2),
        booking.paymentStatus,
        amountCollected.toFixed(2),
        liveGuests.filter((g) => g.checkedIn).length,
        signed,
        liveGuests.length - signed,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  lines.push('');
  lines.push(['TOTAL', '', '', '', '', '', '', '', '', owed.toFixed(2), '', collected.toFixed(2), '', '', ''].map(csvCell).join(','));
  lines.push(['VARIANCE', '', '', '', '', '', '', '', '', (owed - collected).toFixed(2), '', '', '', '', ''].map(csvCell).join(','));

  return {
    filename: `alchemy-${context.venueId}-reconciliation-${dateKey}.csv`,
    csv: lines.join('\n'),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function todayKey(context: Pick<Context, 'timezone'>): string {
  return localDateKey(new Date(), context.timezone);
}
