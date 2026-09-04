import { createHapanaAdapter, type MembershipSource } from '../adapters/hapana/adapter.ts';
import { createMockHapana } from '../adapters/hapana/mock.ts';
import { createMemoryStore } from '../store/memory.ts';
import { createPgStore } from '../store/pg.ts';
import { loadConfig, type AppConfig } from '../lib/config.ts';
import { env } from '../lib/env.ts';
import type { Store } from '../store/types.ts';

/**
 * Per-invocation wiring. Which store and which membership source we get is
 * decided by environment, never by a caller, so no endpoint can quietly opt
 * out of the real backend in production.
 */

export interface Context {
  store: Store;
  membership: MembershipSource;
  config: AppConfig;
  venueId: string;
  venueName: string;
  timezone: string;
}

let cachedStore: Store | null = null;
let cachedMembership: MembershipSource | null = null;

function resolveStore(): Store {
  if (cachedStore) return cachedStore;
  if (process.env.DATABASE_URL) {
    cachedStore = createPgStore();
  } else {
    if (env.isProduction) {
      throw new Error('DATABASE_URL is required in production; refusing to start with the in-memory store');
    }
    console.warn('[member-booking] No DATABASE_URL: using the in-memory store. Nothing will persist.');
    cachedStore = createMemoryStore();
  }
  return cachedStore;
}

function resolveMembership(): MembershipSource {
  if (cachedMembership) return cachedMembership;
  if (process.env.HAPANA_API_KEY) {
    cachedMembership = createHapanaAdapter();
  } else {
    if (env.isProduction) {
      throw new Error('HAPANA_API_KEY is required in production; refusing to start with the mock membership source');
    }
    console.warn('[member-booking] No HAPANA_API_KEY: using the Hapana mock.');
    cachedMembership = createMockHapana({ supportsWrites: false });
  }
  return cachedMembership;
}

export async function buildContext(venueIdOverride?: string): Promise<Context> {
  const store = resolveStore();
  const membership = resolveMembership();
  const config = await loadConfig(store);
  const venueId = venueIdOverride ?? env.defaultVenueId;
  const venue = await store.venue.get(venueId);
  return {
    store,
    membership,
    config,
    venueId,
    venueName: venue?.name ?? 'Alchemy East Fremantle',
    timezone: venue?.timezone ?? 'Australia/Perth',
  };
}

/** Test seam: lets the suite inject a store and membership source. */
export function overrideContext(store: Store | null, membership: MembershipSource | null): void {
  cachedStore = store;
  cachedMembership = membership;
}
