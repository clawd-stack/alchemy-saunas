import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { hashPassword } from '../src/lib/password.ts';
import { MEMBER_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, CANCELLED_MEMBER, PAUSED_MEMBER, VENUE_ID } from './helpers.ts';

import claimHandler from '../netlify/functions/auth-claim.ts';
import loginHandler from '../netlify/functions/auth-login.ts';

/**
 * A member choosing their own password, the first time they use the channel.
 *
 * There is no invitation to check, because there is no email: the membership
 * is the invitation. So everything worth pinning here is about what stands
 * between an address and an account, and about the one thing this must never
 * become, which is a way to take an account off somebody who already has one.
 */

const BASE = 'http://localhost:8888';
const GOOD_PASSWORD = 'a-long-enough-password';

let store: MemoryStore;

function claim(email: string, password = GOOD_PASSWORD): Request {
  return new Request(`${BASE}/api/auth/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function login(email: string, password: string): Request {
  return new Request(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

beforeEach(() => {
  store = createMemoryStore();
  overrideContext(store, createMockHapana({
    members: [ACTIVE_MEMBER, PAUSED_MEMBER, CANCELLED_MEMBER],
    supportsWrites: false,
  }));
});

describe('POST /api/auth/claim', () => {
  it('lets an active member set a password and signs them straight in', async () => {
    const response = await claimHandler(claim(ACTIVE_MEMBER.email));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, kind: 'member', mustChangePassword: false });
    // Signed in, not left on a form to type the password they just chose.
    expect(response.headers.get('set-cookie')).toContain(`${MEMBER_COOKIE}=`);
  });

  it('sets a password that then works at the ordinary sign-in', async () => {
    await claimHandler(claim(ACTIVE_MEMBER.email));
    const response = await loginHandler(login(ACTIVE_MEMBER.email, GOOD_PASSWORD));
    expect(response.status).toBe(200);
    expect((await response.json()).mustChangePassword).toBe(false);
  });

  it('refuses an address that is not a member', async () => {
    const response = await claimHandler(claim('nobody@example.com'));
    expect(response.status).toBe(403);
    expect(await store.credentials.get('nobody@example.com')).toBeNull();
  });

  it('refuses a membership that is not active', async () => {
    // Paused and cancelled both. Somebody who cannot book must not be able to
    // set a password and then wonder why nothing works.
    for (const member of [PAUSED_MEMBER, CANCELLED_MEMBER]) {
      const response = await claimHandler(claim(member.email));
      expect(response.status, member.email).toBe(403);
      expect(await store.credentials.get(member.email), member.email).toBeNull();
    }
  });

  it('never lets an account be taken off somebody who already has one', async () => {
    // The whole reason this is first-login only.
    await store.credentials.setPassword({
      email: ACTIVE_MEMBER.email,
      passwordHash: await hashPassword('the-password-they-already-chose'),
      mustChange: false,
    });

    const response = await claimHandler(claim(ACTIVE_MEMBER.email, 'a-password-somebody-else-picked'));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/already has a password/i);

    // And the one they had still works.
    expect((await loginHandler(login(ACTIVE_MEMBER.email, 'the-password-they-already-chose'))).status).toBe(200);
  });

  it('refuses a suspended sign-in rather than quietly restoring it', async () => {
    await store.credentials.setPassword({
      email: ACTIVE_MEMBER.email,
      passwordHash: await hashPassword('the-password-they-already-chose'),
      mustChange: false,
    });
    await store.credentials.setActive(ACTIVE_MEMBER.email, false);

    const response = await claimHandler(claim(ACTIVE_MEMBER.email));
    expect(response.status).toBe(400);
  });

  it('is not a way for staff to be created or taken over', async () => {
    store.seedStaff({
      staffId: 'staff-1', email: 'door@example.com', displayName: 'Dee Door',
      role: 'door', venueIds: [VENUE_ID], active: true,
    });

    const response = await claimHandler(claim('door@example.com'));
    expect(response.status).toBe(401);
    expect(await store.credentials.get('door@example.com')).toBeNull();
  });

  it('refuses a password too short to be one', async () => {
    const response = await claimHandler(claim(ACTIVE_MEMBER.email, 'short'));
    expect(response.status).toBe(400);
    expect(await store.credentials.get(ACTIVE_MEMBER.email)).toBeNull();
  });

  it('throttles somebody walking a list of addresses', async () => {
    // Same bucket as signing in, so the two cannot be alternated to double the
    // allowance.
    const attempts = [];
    for (let i = 0; i < 12; i += 1) attempts.push((await claimHandler(claim('nobody@example.com'))).status);
    expect(attempts).toContain(429);
  });

  it('refuses anything but a POST', async () => {
    const response = await claimHandler(new Request(`${BASE}/api/auth/claim`, { method: 'GET' }));
    expect(response.status).toBe(400);
  });
});
