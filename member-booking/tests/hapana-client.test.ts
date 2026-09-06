import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHapanaAdapter, sessionWindows } from '../src/adapters/hapana/adapter.ts';
import { hapanaRequest } from '../src/adapters/hapana/client.ts';

/**
 * How this build talks to Hapana.
 *
 * Every one of these was wrong before 2026-09-06, because the documentation
 * was unreachable from the build environment and the client guessed: five
 * candidate auth styles, siteID as a query parameter, v1 paths, a pagination
 * loop for an endpoint with no pagination. The guesses are gone, and what
 * replaced them is pinned here so a refactor cannot quietly reintroduce one.
 *
 * The API itself is never called: fetch is replaced, and what these assert is
 * the request that would have gone out.
 */

const calls: Array<{ url: URL; init: RequestInit }> = [];

function respond(body: unknown, status = 200) {
  return vi.fn(async (input: any, init: any) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const headersOf = (index = 0) => calls[index]!.init.headers as Record<string, string>;

beforeEach(() => {
  calls.length = 0;
  process.env.HAPANA_API_KEY = 'test-access-id';
  process.env.HAPANA_SITE_ID = 'site-east-fremantle';
  process.env.HAPANA_BASE_URL = 'https://api.hapana.com';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HAPANA_SITE_ID;
});

describe('authentication', () => {
  it('sends the key and the site as headers named accessID and siteID', async () => {
    vi.stubGlobal('fetch', respond({ data: [] }));
    await hapanaRequest('v2/customer/client');

    expect(headersOf().accessID).toBe('test-access-id');
    expect(headersOf().siteID).toBe('site-east-fremantle');
  });

  it('sends none of the schemes it used to guess at', async () => {
    vi.stubGlobal('fetch', respond({ data: [] }));
    await hapanaRequest('v2/customer/client');

    const headers = headersOf();
    for (const wrong of ['x-api-key', 'authorization', 'apikey', 'x-site-id', 'x-company-id']) {
      expect(headers[wrong], wrong).toBeUndefined();
    }
    // The key never travels in the URL, where it would land in a log.
    expect(calls[0]!.url.search).not.toContain('test-access-id');
    expect(calls[0]!.url.searchParams.get('siteID')).toBeNull();
  });

  it('omits siteID rather than sending the word undefined', async () => {
    delete process.env.HAPANA_SITE_ID;
    vi.stubGlobal('fetch', respond({ data: [] }));
    await hapanaRequest('v2/customer/client');
    expect(headersOf().siteID).toBeUndefined();
  });
});

describe('members', () => {
  it('looks a member up by email in one call, at the v2 client endpoint', async () => {
    vi.stubGlobal('fetch', respond({ data: [{ clientID: 'c1', email: 'ada@example.com', status: 'active' }] }));
    const member = await createHapanaAdapter().findMemberByEmail('ada@example.com');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/v2/customer/client');
    expect(calls[0]!.url.searchParams.get('email')).toBe('ada@example.com');
    expect(member?.memberId).toBe('c1');
  });

  it('does not trust a filter it did not write', async () => {
    // If the endpoint ever returns a near match, sign-in must not accept it.
    vi.stubGlobal('fetch', respond({ data: [{ clientID: 'c9', email: 'someone.else@example.com', status: 'active' }] }));
    expect(await createHapanaAdapter().findMemberByEmail('ada@example.com')).toBeNull();
  });

  it('asks for the whole membership once, with no pagination parameters', async () => {
    // The endpoint has none. The loop this replaced would have sent page=1..50
    // and read the same first response fifty times.
    vi.stubGlobal('fetch', respond({ data: [{ clientID: 'c1', email: 'ada@example.com', status: 'active' }] }));
    await createHapanaAdapter().listMembers();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('page')).toBeNull();
    expect(calls[0]!.url.searchParams.get('limit')).toBeNull();
    expect(calls[0]!.url.searchParams.get('lastModifiedDate')).toBeNull();
  });

  it('asks only for what changed when it has a high-water mark', async () => {
    vi.stubGlobal('fetch', respond({ data: [] }));
    await createHapanaAdapter().listMembers(new Date('2026-09-01T04:05:06.000Z'));

    // Y-m-d H:i:s, which is what the endpoint documents.
    expect(calls[0]!.url.searchParams.get('lastModifiedDate')).toBe('2026-09-01 04:05:06');
  });

  it('refuses to pretend it can look a member up by id', async () => {
    vi.stubGlobal('fetch', respond({ data: [] }));
    await expect(createHapanaAdapter().getMember('c1')).rejects.toThrow(/lookup by member id/);
    expect(calls).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('cuts a range into windows of at most 15 days', () => {
    const windows = sessionWindows(new Date('2026-09-01T00:00:00Z'), new Date('2026-10-05T00:00:00Z'));
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      const days = (window.to.getTime() - window.from.getTime()) / 86_400_000;
      expect(days).toBeLessThanOrEqual(15);
    }
    expect(windows[0]!.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(windows.at(-1)!.to.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('leaves a range inside the cap as one window', () => {
    expect(sessionWindows(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-14T00:00:00Z'))).toHaveLength(1);
  });

  it('asks for dates, not timestamps, and one call per window', async () => {
    vi.stubGlobal('fetch', respond({ data: [] }));
    await createHapanaAdapter().listSessions('east-fremantle', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe('/v2/site/sessions');
    expect(calls[0]!.url.searchParams.get('startDate')).toBe('2026-09-01');
    expect(calls[0]!.url.searchParams.get('startDate')).not.toContain('T');
    expect(calls[1]!.url.searchParams.get('endDate')).toBe('2026-09-25');
  });
});

describe('booking', () => {
  it('refuses to create or cancel a booking at all', async () => {
    // Not a configuration this deployment lacks. The published API has no
    // endpoint for it, so there is nothing to switch on.
    const adapter = createHapanaAdapter();
    await expect(adapter.createBooking({
      externalSessionId: 's1', memberId: 'c1', spots: 1, reference: 'b1',
    })).rejects.toThrow(/creating a booking/);
    await expect(adapter.cancelBooking('b1')).rejects.toThrow(/cancelling a booking/);
    expect(calls).toHaveLength(0);
  });
});
