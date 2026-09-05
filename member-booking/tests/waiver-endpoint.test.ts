import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { hashToken } from '../src/lib/crypto.ts';
import { SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from '../src/lib/signature.ts';
import { VENUE_ID } from './helpers.ts';

import waiverHandler from '../netlify/functions/waiver.ts';

/**
 * The waiver endpoint, which a guest reaches with a token and nothing else.
 *
 * A waiver is a liability record, so what it will and will not accept as a
 * signature is asserted here rather than left to the page: the page can be
 * skipped entirely by anyone posting straight at the endpoint.
 */

const BASE = 'http://localhost:8888';
const TOKEN = 'w'.repeat(43);
const SIGNATURE = 'M120 260L240 140L300 280L420 130';

let store: MemoryStore;

async function seedWaiver(): Promise<string> {
  const waiver = await store.waivers.create({
    tokenHash: hashToken(TOKEN),
    bookingId: '00000000-0000-0000-0000-000000000001',
    guestId: '00000000-0000-0000-0000-000000000002',
    venueId: VENUE_ID,
    sessionStartsAt: new Date(Date.now() + 86_400_000),
    guestName: 'Guest One',
    guestEmail: 'guest1@example.com',
    waiverVersion: 'TEST-1',
  });
  return waiver.waiverId;
}

const get = (token: string) => new Request(`${BASE}/api/waiver?token=${encodeURIComponent(token)}`);
const post = (body: unknown) =>
  new Request(`${BASE}/api/waiver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  store = createMemoryStore();
  overrideContext(store, createMockHapana({ supportsWrites: false }));
  await seedWaiver();
});

describe('POST /api/waiver', () => {
  it('records the drawn signature alongside the typed name', async () => {
    const response = await waiverHandler(post({ token: TOKEN, signedName: 'Guest One', signature: SIGNATURE, agreed: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('signed');

    const stored = await store.waivers.getByTokenHash(hashToken(TOKEN));
    expect(stored?.signature).toBe(SIGNATURE);
  });

  it('refuses to record a signing with nothing drawn', async () => {
    const response = await waiverHandler(post({ token: TOKEN, signedName: 'Guest One', agreed: true }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/sign in the box/i);

    // And nothing was recorded: an unsigned waiver is resolved at the door,
    // which is a better outcome than one recorded as signed with no signature.
    expect((await store.waivers.getByTokenHash(hashToken(TOKEN)))?.status).not.toBe('signed');
  });

  it('refuses a signature that is not plain path data', async () => {
    const response = await waiverHandler(
      post({ token: TOKEN, signedName: 'Guest One', signature: '<script>alert(1)</script>', agreed: true }),
    );
    expect(response.status).toBe(400);
    expect((await store.waivers.getByTokenHash(hashToken(TOKEN)))?.status).not.toBe('signed');
  });

  it('still requires the tick box', async () => {
    const response = await waiverHandler(post({ token: TOKEN, signedName: 'Guest One', signature: SIGNATURE }));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/waiver', () => {
  it('tells the page which coordinate space to draw in', async () => {
    const body = await (await waiverHandler(get(TOKEN))).json();
    expect(body.signatureBox).toEqual({ width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT });
  });

  it('gives an unsigned waiver no signature to show', async () => {
    const body = await (await waiverHandler(get(TOKEN))).json();
    expect(body.waiver.status).not.toBe('signed');
    expect(body.waiver.signature).toBeNull();
  });

  it('shows a guest what they signed', async () => {
    await waiverHandler(post({ token: TOKEN, signedName: 'Guest One', signature: SIGNATURE, agreed: true }));
    const body = await (await waiverHandler(get(TOKEN))).json();
    expect(body.waiver.status).toBe('signed');
    expect(body.waiver.signature).toBe(SIGNATURE);
  });
});
