import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, VENUE_ID } from './helpers.ts';

import peopleHandler from '../netlify/functions/admin-people.ts';

/**
 * Bulk import from a membership export.
 *
 * The file is somebody else's work product, so most of what is pinned here is
 * what happens when it is wrong: an address that belongs to staff, the same
 * person twice, a row with no address, a partial export that omits half the
 * membership. None of those may quietly do damage, and the plan returned
 * before anything is written has to be the plan that is actually carried out.
 */

const BASE = 'http://localhost:8888';

const ADMIN = {
  staffId: 'staff-admin',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin' as const,
  venueIds: [VENUE_ID],
  active: true,
};

let store: MemoryStore;

const cookie = () => `${STAFF_COOKIE}=${issueStaffSession(ADMIN)}`;

function post(body: unknown): Request {
  return new Request(`${BASE}/api/admin/people`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify(body),
  });
}

async function importRows(rows: unknown[], options: Record<string, unknown> = {}) {
  const response = await peopleHandler(post({ action: 'import', rows, ...options }));
  return { status: response.status, body: await response.json() };
}

async function members() {
  const body = await (await peopleHandler(new Request(`${BASE}/api/admin/people`, { headers: { cookie: cookie() } }))).json();
  return new Map<string, any>(body.people.map((p: any) => [p.email, p]));
}

const ROWS = [
  { email: 'Ada@Example.com', name: 'Ada Active', membershipType: 'Unlimited' },
  { email: 'ben@example.com', firstName: 'Ben', lastName: 'Byte', membershipType: 'Unlimited' },
  { email: 'cas@example.com', name: 'Cas Casual', membershipType: 'Casual pack' },
];

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER], supportsWrites: false }));
});

describe('POST /api/admin/people { action: import }', () => {
  it('writes nothing until it is told to apply', async () => {
    const { body } = await importRows(ROWS);
    expect(body.applied).toBe(false);
    expect(body.plan.add).toHaveLength(3);
    expect((await members()).size).toBe(1); // the admin, and nobody else
  });

  it('carries out exactly the plan it showed', async () => {
    const dry = await importRows(ROWS);
    const wet = await importRows(ROWS, { apply: true });

    expect(wet.body.applied).toBe(true);
    expect(wet.body.plan.add.map((p: any) => p.email)).toEqual(dry.body.plan.add.map((p: any) => p.email));

    const people = await members();
    expect(people.get('ada@example.com').name).toBe('Ada Active');
    expect(people.get('ben@example.com').name).toBe('Ben Byte');
    expect(people.get('cas@example.com').status).toBe('active');
  });

  it('counts the membership types in the file so they can be chosen', async () => {
    const { body } = await importRows(ROWS);
    expect(body.types).toEqual([
      { type: 'Unlimited', count: 2 },
      { type: 'Casual pack', count: 1 },
    ]);
  });

  it('imports only the types asked for', async () => {
    const { body } = await importRows(ROWS, { types: ['unlimited'], apply: true });
    expect(body.plan.add.map((p: any) => p.email)).toEqual(['ada@example.com', 'ben@example.com']);
    expect(body.plan.excludedByType).toBe(1);
    expect((await members()).has('cas@example.com')).toBe(false);
  });

  it('reads an empty type list as none, not as all', async () => {
    // Somebody unticking every type is giving a real answer. Reading it as
    // "all of them" would import the whole file at the moment they said not to.
    const { body } = await importRows(ROWS, { types: [], apply: true });
    expect(body.plan.add).toHaveLength(0);
    expect((await members()).size).toBe(1);
  });

  it('never lets a spreadsheet demote a member of staff', async () => {
    const { body } = await importRows([...ROWS, { email: 'admin@example.com', name: 'Ada Admin' }], { apply: true });
    expect(body.plan.skippedStaff).toEqual(['admin@example.com']);
    expect((await members()).get('admin@example.com').role).toBe('admin');
  });

  it('takes the first of a duplicated address and says so', async () => {
    const { body } = await importRows([...ROWS, { email: 'ada@example.com', name: 'Ada Twice' }], { apply: true });
    expect(body.plan.duplicates).toBe(1);
    expect((await members()).get('ada@example.com').name).toBe('Ada Active');
  });

  it('skips a row with no usable address', async () => {
    const { body } = await importRows([...ROWS, { name: 'No Address' }, { email: 'not-an-address' }]);
    expect(body.plan.invalid).toBe(2);
    expect(body.plan.add).toHaveLength(3);
  });

  it('is safe to run twice', async () => {
    await importRows(ROWS, { apply: true });
    const { body } = await importRows(ROWS, { apply: true });
    expect(body.plan.add).toHaveLength(0);
    expect(body.plan.update).toHaveLength(0);
    expect(body.plan.unchanged).toBe(3);
    expect((await members()).size).toBe(4);
  });

  it('updates somebody whose status or name changed', async () => {
    await importRows(ROWS, { apply: true });
    const { body } = await importRows(
      [{ email: 'ada@example.com', name: 'Ada Active', membershipType: 'Unlimited', status: 'paused' }],
      { types: null, apply: true },
    );
    expect(body.plan.update.map((p: any) => p.email)).toEqual(['ada@example.com']);
    expect((await members()).get('ada@example.com').status).toBe('paused');
  });

  it('maps a status it does not recognise to suspended rather than active', async () => {
    // The safe direction. An unknown state that refuses a booking is a support
    // call; one that permits a booking is an unauthorised entry.
    await importRows([{ email: 'odd@example.com', name: 'Odd One', status: 'mid-transfer' }], { apply: true });
    expect((await members()).get('odd@example.com').status).toBe('suspended');
  });

  it('reports who is in the app but not in the file, without touching them', async () => {
    await importRows(ROWS, { apply: true });
    const { body } = await importRows([ROWS[0]], { apply: true });

    expect(body.plan.missing.map((p: any) => p.email).sort()).toEqual(['ben@example.com', 'cas@example.com']);
    // A partial export must not cancel everybody it happens to leave out.
    expect((await members()).get('ben@example.com').status).toBe('active');
  });

  it('cancels the ones left out only when asked, and keeps the record', async () => {
    await importRows(ROWS, { apply: true });
    await importRows([ROWS[0]], { apply: true, deactivateMissing: true });

    const people = await members();
    expect(people.get('ben@example.com').status).toBe('cancelled');
    // Cancelled, not deleted: a past booking naming them still resolves.
    expect(people.has('ben@example.com')).toBe(true);
    expect(people.get('ada@example.com').status).toBe('active');
  });

  it('refuses a file larger than it will process', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ email: `m${i}@example.com`, name: `M ${i}` }));
    const { status, body } = await importRows(many);
    expect(status).toBe(400);
    expect(body.message).toMatch(/5000 at a time/);
  });

  it('is admin only', async () => {
    const doorCookie = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, role: 'door', staffId: 'staff-door', email: 'door@example.com' })}`;
    const response = await peopleHandler(new Request(`${BASE}/api/admin/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doorCookie },
      body: JSON.stringify({ action: 'import', rows: ROWS, apply: true }),
    }));
    expect(response.status).toBe(403);
    expect((await members()).size).toBe(1);
  });
});
