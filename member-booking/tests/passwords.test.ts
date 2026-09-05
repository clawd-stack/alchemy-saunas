import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueStaffSession, issueMemberSession } from '../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE } from '../src/lib/http.ts';
import {
  DUMMY_HASH,
  generatePassword,
  hashPassword,
  needsRehash,
  readPassword,
  validatePassword,
  verifyPassword,
} from '../src/lib/password.ts';
import { ACTIVE_MEMBER, PAUSED_MEMBER, VENUE_ID } from './helpers.ts';

import loginHandler from '../netlify/functions/auth-login.ts';
import passwordHandler from '../netlify/functions/auth-password.ts';
import peopleHandler from '../netlify/functions/admin-people.ts';

/**
 * Password sign-in.
 *
 * The tests that matter here are the ones about what the endpoints refuse and
 * what they decline to reveal. A login form is an oracle by default: it will
 * happily tell an anonymous caller which addresses hold a membership unless it
 * is built not to, and that is the property most easily lost in a later edit.
 */

const BASE = 'http://localhost:8888';
const GOOD_PASSWORD = 'correct-horse-battery';

let store: MemoryStore;

const ADMIN = {
  staffId: 'staff-admin',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin' as const,
  venueIds: [VENUE_ID],
  active: true,
};

function request(path: string, body: unknown, cookie?: string, method = 'POST'): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

function adminCookie() {
  return `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, displayName: ADMIN.displayName })}`;
}

function memberCookie() {
  return `${MEMBER_COOKIE}=${issueMemberSession({
    memberId: ACTIVE_MEMBER.memberId,
    email: ACTIVE_MEMBER.email,
    name: 'Ada Active',
  })}`;
}

async function seedCredential(email: string, password: string, mustChange = false) {
  await store.credentials.setPassword({ email, passwordHash: await hashPassword(password), mustChange });
}

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER, PAUSED_MEMBER], supportsWrites: false }));
});

describe('password hashing', () => {
  it('round-trips, and rejects the wrong password', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD + 'x', hash)).toBe(false);
  });

  it('salts, so the same password never produces the same hash twice', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD_PASSWORD), hashPassword(GOOD_PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD_PASSWORD, a)).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD, b)).toBe(true);
  });

  it('stores no trace of the password itself', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(hash).not.toContain(GOOD_PASSWORD);
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
  });

  it('reads the cost parameters back out of the hash, so they can be raised later', async () => {
    // A hash made at a lower cost must still verify, and must be flagged for
    // rewriting. Without this, raising the cost would lock everybody out.
    const weak = 'scrypt$16384$8$1$' + (await hashPassword(GOOD_PASSWORD)).split('$').slice(4).join('$');
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword(GOOD_PASSWORD))).toBe(false);
  });

  it('refuses a malformed or corrupt stored hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$0$0$0$x$y', 'bcrypt$1$2$3$4$5', DUMMY_HASH]) {
      expect(await verifyPassword(GOOD_PASSWORD, bad)).toBe(false);
    }
  });

  it('generates readable passwords with no ambiguous characters', () => {
    for (let i = 0; i < 30; i += 1) {
      const generated = generatePassword();
      expect(readPassword(generated)).toHaveLength(20);
      expect(generated).not.toMatch(/[01oOlLiI]/);
      expect(validatePassword(readPassword(generated))).toBeNull();
    }
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });

  it('keeps a password exactly as typed, punctuation and all', async () => {
    // The regression this guards: an earlier version stripped dashes so that a
    // dash-grouped generated password could be typed either way, which silently
    // turned "my-secure-phrase" into a different, shorter password.
    const chosen = 'my-secure-phrase!';
    const hash = await hashPassword(readPassword(chosen));
    expect(await verifyPassword(chosen, hash)).toBe(true);
    expect(await verifyPassword('mysecurephrase!', hash)).toBe(false);
    expect(generatePassword()).not.toContain('-');
  });

  it('trims surrounding whitespace, which is a paste artefact and not a choice', () => {
    expect(readPassword('  spaced-out-password  ')).toBe('spaced-out-password');
    expect(readPassword(undefined)).toBe('');
    expect(readPassword(12345)).toBe('');
  });

  it('holds the line on length', () => {
    expect(validatePassword('short')).not.toBeNull();
    expect(validatePassword('a'.repeat(12))).toBeNull();
    expect(validatePassword('a'.repeat(500))).not.toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  it('signs a member in with the right password', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    const response = await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe('member');
    expect(body.name).toBe('Ada Active');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(MEMBER_COOKIE);
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('signs staff in, and does not look them up as a member', async () => {
    await seedCredential(ADMIN.email, GOOD_PASSWORD);
    const body = await (await loginHandler(request('/api/auth/login', { email: ADMIN.email, password: GOOD_PASSWORD }))).json();
    expect(body.kind).toBe('staff');
    expect(body.role).toBe('admin');
  });

  /**
   * The central property: every refusal is the same refusal. An unknown
   * address, a wrong password, a suspended account and a paused membership must
   * be indistinguishable, or this endpoint becomes a way to ask who is a member.
   */
  it('refuses identically whatever the reason', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    await seedCredential(PAUSED_MEMBER.email, GOOD_PASSWORD);
    await seedCredential('suspended@example.com', GOOD_PASSWORD);
    await store.credentials.setActive('suspended@example.com', false);

    const attempts = [
      { email: 'nobody@example.com', password: GOOD_PASSWORD },      // no such account
      { email: ACTIVE_MEMBER.email, password: 'wrong-password-here' }, // wrong password
      { email: PAUSED_MEMBER.email, password: GOOD_PASSWORD },        // membership not active
      { email: 'suspended@example.com', password: GOOD_PASSWORD },    // sign-in suspended
    ];

    const seen = new Set<string>();
    for (const attempt of attempts) {
      const response = await loginHandler(request('/api/auth/login', attempt));
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
      seen.add(JSON.stringify(await response.json()));
    }
    expect(seen.size).toBe(1);
  });

  it('refuses an empty or missing password', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email }))).status).toBe(401);
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: '' }))).status).toBe(401);
  });

  it('rejects a malformed email', async () => {
    expect((await loginHandler(request('/api/auth/login', { email: 'not-an-email', password: GOOD_PASSWORD }))).status).toBe(400);
  });

  it('reports that an issued password still has to be changed', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD, true);
    const body = await (await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }))).json();
    expect(body.mustChangePassword).toBe(true);
  });

  it('records the sign-in', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    expect((await store.credentials.get(ACTIVE_MEMBER.email))?.lastLoginAt).toBeNull();
    await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }));
    expect((await store.credentials.get(ACTIVE_MEMBER.email))?.lastLoginAt).not.toBeNull();
  });

  it('throttles password guessing', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: `guess-${i}` }));
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // And the brake still holds once the right password shows up.
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }))).status).toBe(429);
  });

  it('leaves a hash alone when it is already at the current cost', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    const before = (await store.credentials.get(ACTIVE_MEMBER.email))!.passwordHash;
    expect(needsRehash(before)).toBe(false);

    await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }));

    // A pointless rewrite on every sign-in would be a write amplification bug.
    expect((await store.credentials.get(ACTIVE_MEMBER.email))!.passwordHash).toBe(before);
  });
});

describe('signing in with a password that still has to be changed', () => {
  /**
   * The regression this guards is a UI one with a nasty shape: the sign-in
   * succeeded, the cookie was set, and the page still showed the sign-in form,
   * because the handler returned early to show the change-password step. From
   * the outside that is identical to a rejected password, and it is the one
   * failure a person cannot tell apart or work around.
   *
   * The API contract the fixed screen relies on: a must-change sign-in is a
   * complete, working sign-in that happens to carry a flag.
   */
  it('is a real sign-in, cookie and all, not a half state', async () => {
    await seedCredential(ADMIN.email, GOOD_PASSWORD, true);
    const response = await loginHandler(request('/api/auth/login', { email: ADMIN.email, password: GOOD_PASSWORD }));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(STAFF_COOKIE);

    const body = await response.json();
    expect(body.mustChangePassword).toBe(true);
    expect(body.role).toBe('admin');

    // And the session it issued genuinely works, rather than waiting on the
    // password being changed first.
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await peopleHandler(get('/api/admin/people', cookie))).status).toBe(200);
  });
});

describe('POST /api/auth/password', () => {
  it('requires a session', async () => {
    const response = await passwordHandler(
      request('/api/auth/password', { currentPassword: GOOD_PASSWORD, newPassword: 'a-new-long-password' }),
    );
    expect(response.status).toBe(401);
  });

  it('changes the password and clears the must-change flag', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD, true);
    const response = await passwordHandler(
      request('/api/auth/password', { currentPassword: GOOD_PASSWORD, newPassword: 'a-new-long-password' }, memberCookie()),
    );
    expect(response.status).toBe(200);

    const saved = await store.credentials.get(ACTIVE_MEMBER.email);
    expect(saved?.mustChange).toBe(false);
    expect(await verifyPassword('a-new-long-password', saved!.passwordHash)).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD, saved!.passwordHash)).toBe(false);
  });

  it('demands the current password, because a session can be a borrowed phone', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    const response = await passwordHandler(
      request('/api/auth/password', { currentPassword: 'not-it', newPassword: 'a-new-long-password' }, memberCookie()),
    );
    expect(response.status).toBe(401);
    expect(await verifyPassword(GOOD_PASSWORD, (await store.credentials.get(ACTIVE_MEMBER.email))!.passwordHash)).toBe(true);
  });

  it('enforces the length floor and refuses a no-op change', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    expect(
      (await passwordHandler(request('/api/auth/password', { currentPassword: GOOD_PASSWORD, newPassword: 'short' }, memberCookie()))).status,
    ).toBe(400);
    expect(
      (await passwordHandler(request('/api/auth/password', { currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD }, memberCookie()))).status,
    ).toBe(400);
  });

  it('changes only the caller, whatever the body says', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    await seedCredential(ADMIN.email, GOOD_PASSWORD);

    await passwordHandler(
      request(
        '/api/auth/password',
        { email: ADMIN.email, currentPassword: GOOD_PASSWORD, newPassword: 'a-new-long-password' },
        memberCookie(),
      ),
    );

    // The admin's password is untouched: the address came from the cookie.
    expect(await verifyPassword(GOOD_PASSWORD, (await store.credentials.get(ADMIN.email))!.passwordHash)).toBe(true);
  });
});
