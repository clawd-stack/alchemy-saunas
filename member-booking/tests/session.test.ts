import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueMemberSession, issueStaffSession } from '../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, VENUE_ID } from './helpers.ts';

import sessionHandler from '../netlify/functions/auth-session.ts';

/**
 * GET /api/auth/session.
 *
 * Every page reads this to decide what to draw, so a field quietly missing
 * from the response does not fail anywhere: it renders as the string
 * "undefined" on a screen. That is exactly how the admin header shipped
 * reading "undefined · admin", so the shape is asserted here rather than
 * trusted.
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

function get(cookie?: string): Request {
  return new Request(`${BASE}/api/auth/session`, { headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ supportsWrites: false }));
});

describe('GET /api/auth/session', () => {
  it('describes a signed-in staff member well enough to render a header', async () => {
    const cookie = `${STAFF_COOKIE}=${issueStaffSession(ADMIN)}`;
    const body = await (await sessionHandler(get(cookie))).json();

    expect(body.staff).toMatchObject({
      name: 'Ada Admin',
      email: 'admin@example.com',
      role: 'admin',
    });
    // The bug this file exists for: any of these arriving undefined renders
    // as the literal word on the page.
    for (const key of ['name', 'email', 'role'] as const) {
      expect(body.staff[key], `staff.${key}`).toBeTruthy();
    }
  });

  it('describes a signed-in member the same way', async () => {
    const cookie = `${MEMBER_COOKIE}=${issueMemberSession({
      memberId: ACTIVE_MEMBER.memberId,
      email: ACTIVE_MEMBER.email,
      name: 'Ada Active',
    })}`;
    const body = await (await sessionHandler(get(cookie))).json();

    expect(body.member).toMatchObject({
      memberId: ACTIVE_MEMBER.memberId,
      email: ACTIVE_MEMBER.email,
      name: 'Ada Active',
    });
    expect(body.staff).toBeNull();
  });

  it('answers for an anonymous caller rather than refusing', async () => {
    // The member header calls this on every page load, signed in or not. A
    // 401 here would put an error in the console of every visitor.
    const response = await sessionHandler(get());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.member).toBeNull();
    expect(body.staff).toBeNull();
  });

  it('does not hand a member session any staff standing', async () => {
    const cookie = `${MEMBER_COOKIE}=${issueMemberSession({
      memberId: ACTIVE_MEMBER.memberId,
      email: ACTIVE_MEMBER.email,
      name: 'Ada Active',
    })}`;
    const body = await (await sessionHandler(get(cookie))).json();
    expect(body.staff).toBeNull();
  });
});
