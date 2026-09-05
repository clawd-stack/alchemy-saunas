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
import credentialsHandler from '../netlify/functions/admin-credentials.ts';

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

describe('/api/admin/credentials', () => {
  it('is closed to anyone but an admin', async () => {
    expect((await credentialsHandler(get('/api/admin/credentials'))).status).toBe(401);
    const manager = `${STAFF_COOKIE}=${issueStaffSession({
      staffId: 's2',
      email: 'manager@example.com',
      displayName: 'Mo Manager',
      role: 'manager',
      venueIds: [VENUE_ID],
    })}`;
    expect((await credentialsHandler(get('/api/admin/credentials', manager))).status).toBe(403);
  });

  it('issues a generated password, returned exactly once', async () => {
    const body = await (await credentialsHandler(
      request('/api/admin/credentials', { email: ACTIVE_MEMBER.email }, adminCookie()),
    )).json();

    expect(body.password).toBeTruthy();
    expect(body.resolvesTo).toContain('member');

    // It works.
    const login = await loginHandler(
      request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: body.password }),
    );
    expect(login.status).toBe(200);
    expect((await login.json()).mustChangePassword).toBe(true);

    // And it is not retrievable afterwards, from anywhere.
    const list = await (await credentialsHandler(get('/api/admin/credentials', adminCookie()))).json();
    const account = list.accounts.find((a: any) => a.email === ACTIVE_MEMBER.email);
    expect(account).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain(body.password);
    expect(JSON.stringify(list)).not.toContain('scrypt$');
  });

  it('accepts a supplied password, and still marks it must-change', async () => {
    const body = await (await credentialsHandler(
      request('/api/admin/credentials', { email: ACTIVE_MEMBER.email, password: 'a-supplied-password' }, adminCookie()),
    )).json();
    expect(body.password).toBeNull();
    expect((await store.credentials.get(ACTIVE_MEMBER.email))?.mustChange).toBe(true);
  });

  it('rejects a supplied password that is too short', async () => {
    const response = await credentialsHandler(
      request('/api/admin/credentials', { email: ACTIVE_MEMBER.email, password: 'short' }, adminCookie()),
    );
    expect(response.status).toBe(400);
  });

  it('says plainly when an address will not resolve to anybody', async () => {
    const body = await (await credentialsHandler(
      request('/api/admin/credentials', { email: 'typo@example.com' }, adminCookie()),
    )).json();
    // Sign-in refuses identically for every reason, so the admin screen has to
    // be the place that catches a typo.
    expect(body.resolvesTo).toContain('nobody yet');
  });

  it('resets an existing account rather than creating a second one', async () => {
    await credentialsHandler(request('/api/admin/credentials', { email: ACTIVE_MEMBER.email }, adminCookie()));
    const second = await (await credentialsHandler(
      request('/api/admin/credentials', { email: ACTIVE_MEMBER.email }, adminCookie()),
    )).json();

    expect((await store.credentials.list()).filter((c) => c.email === ACTIVE_MEMBER.email)).toHaveLength(1);
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: second.password }))).status).toBe(200);
  });

  it('suspends and restores sign-in', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);

    await credentialsHandler(request('/api/admin/credentials', { email: ACTIVE_MEMBER.email, active: false }, adminCookie(), 'PATCH'));
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }))).status).toBe(401);

    await credentialsHandler(request('/api/admin/credentials', { email: ACTIVE_MEMBER.email, active: true }, adminCookie(), 'PATCH'));
    expect((await loginHandler(request('/api/auth/login', { email: ACTIVE_MEMBER.email, password: GOOD_PASSWORD }))).status).toBe(200);
  });

  it('deletes an account', async () => {
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);
    const response = await credentialsHandler(
      request('/api/admin/credentials', { email: ACTIVE_MEMBER.email }, adminCookie(), 'DELETE'),
    );
    expect(response.status).toBe(200);
    expect(await store.credentials.get(ACTIVE_MEMBER.email)).toBeNull();
    expect((await credentialsHandler(request('/api/admin/credentials', { email: ACTIVE_MEMBER.email }, adminCookie(), 'DELETE'))).status).toBe(404);
  });

  it('refuses to let an admin lock themselves out', async () => {
    await seedCredential(ADMIN.email, GOOD_PASSWORD);
    expect(
      (await credentialsHandler(request('/api/admin/credentials', { email: ADMIN.email, active: false }, adminCookie(), 'PATCH'))).status,
    ).toBe(400);
    expect(
      (await credentialsHandler(request('/api/admin/credentials', { email: ADMIN.email }, adminCookie(), 'DELETE'))).status,
    ).toBe(400);
    expect((await store.credentials.get(ADMIN.email))?.active).toBe(true);
  });

  it('labels staff and members distinctly in the listing', async () => {
    await seedCredential(ADMIN.email, GOOD_PASSWORD);
    await seedCredential(ACTIVE_MEMBER.email, GOOD_PASSWORD);

    const body = await (await credentialsHandler(get('/api/admin/credentials', adminCookie()))).json();
    const byEmail = new Map(body.accounts.map((a: any) => [a.email, a]));
    expect((byEmail.get(ADMIN.email) as any).kind).toBe('staff');
    expect((byEmail.get(ADMIN.email) as any).role).toBe('admin');
    expect((byEmail.get(ACTIVE_MEMBER.email) as any).kind).toBe('member');
  });
});
