import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { CONFIG_DEFAULTS, type AppConfig } from '../src/lib/config.ts';
import type { Context } from '../src/domain/context.ts';
import type { HapanaMember } from '../src/adapters/hapana/types.ts';

export const VENUE_ID = 'east-fremantle';

export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

/** A session that is comfortably inside the booking window. */
export function futureSession(hoursAhead = 48): { id: string; startsAt: Date; endsAt: Date } {
  const startsAt = hoursFromNow(hoursAhead);
  startsAt.setUTCMinutes(0, 0, 0);
  return {
    id: `${VENUE_ID}:${startsAt.toISOString().slice(0, 16)}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
  };
}

export const ACTIVE_MEMBER: HapanaMember = {
  memberId: 'mem-active-1',
  email: 'active@example.com',
  firstName: 'Ada',
  lastName: 'Active',
  status: 'active',
  homeVenueId: VENUE_ID,
};

export const PAUSED_MEMBER: HapanaMember = {
  memberId: 'mem-paused-1',
  email: 'paused@example.com',
  firstName: 'Pat',
  lastName: 'Paused',
  status: 'paused',
  homeVenueId: VENUE_ID,
};

export const CANCELLED_MEMBER: HapanaMember = {
  memberId: 'mem-cancelled-1',
  email: 'cancelled@example.com',
  firstName: 'Cass',
  lastName: 'Cancelled',
  status: 'cancelled',
  homeVenueId: VENUE_ID,
};

export interface TestHarness {
  context: Context;
  store: MemoryStore;
  hapana: ReturnType<typeof createMockHapana>;
  session: ReturnType<typeof futureSession>;
}

export function makeHarness(options: {
  config?: Partial<AppConfig>;
  members?: HapanaMember[];
  supportsWrites?: boolean;
  publicBooked?: Record<string, number>;
  sessionHoursAhead?: number;
} = {}): TestHarness {
  const store = createMemoryStore();
  const session = futureSession(options.sessionHoursAhead ?? 48);

  const hapana = createMockHapana({
    members: options.members ?? [ACTIVE_MEMBER, PAUSED_MEMBER, CANCELLED_MEMBER],
    supportsWrites: options.supportsWrites ?? false,
    publicBooked: options.publicBooked ?? {},
    sessions: [
      {
        externalSessionId: session.id,
        venueId: VENUE_ID,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        booked: options.publicBooked?.[session.id] ?? 0,
        capacity: 20,
        classId: 'member-class',
        name: 'Member session',
      },
    ],
  });

  store.seedSession({
    venueId: VENUE_ID,
    externalSessionId: session.id,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
  });

  const context: Context = {
    store,
    membership: hapana,
    config: { ...CONFIG_DEFAULTS, ...options.config },
    venueId: VENUE_ID,
    venueName: 'Alchemy East Fremantle',
    timezone: 'Australia/Perth',
  };

  return { context, store, hapana, session };
}

export function guests(count: number): Array<{ name: string; email: string }> {
  return Array.from({ length: count }, (_, index) => ({
    name: `Guest ${index + 1}`,
    email: `guest${index + 1}@example.com`,
  }));
}
