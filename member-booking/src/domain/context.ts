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

async function resolveStore(): Promise<Store> {
  if (cachedStore) return cachedStore;

  // An explicit connection string wins, so local work and CI can point at
  // their own Postgres. Otherwise ask Netlify DB, which provisions the
  // database on deploy and knows which branch this deploy should talk to.
  if (env.hasDatabaseUrl) {
    cachedStore = createPgStore();
    return cachedStore;
  }

  try {
    const { getConnectionString } = await import('@netlify/database');
    const connectionString = getConnectionString();
    if (connectionString) {
      cachedStore = createPgStore(connectionString);
      return cachedStore;
    }
  } catch {
    // Not running on Netlify, or the package is unavailable. Fall through.
  }

  if (env.isProduction) {
    throw new Error('No database available in production; refusing to start with the in-memory store');
  }
  console.warn('[member-booking] No database: using the in-memory store. Nothing will persist.');
  cachedStore = createMemoryStore();
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
  const store = await resolveStore();
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
