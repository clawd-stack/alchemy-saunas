import { hashPassword } from '../lib/password.ts';
import type { Store } from '../store/types.ts';

/**
 * The first admin, from the environment rather than from a migration.
 *
 * Seeding an admin password in a migration puts its hash in the repository,
 * and this repository is public. scrypt makes that expensive to attack rather
 * than impossible, and the hash stays valid until somebody changes the
 * password, which is not a property to hand out with a git clone. Migration
 * 007 does exactly that for the existing bootstrap account and should be
 * treated as compromised until that password is changed.
 *
 * So the password lives in ADMIN_BOOTSTRAP_PASSWORD, is read only in the
 * process, and is written as a hash the first time the named address tries to
 * sign in.
 *
 * Three properties make this safe to leave switched on:
 *
 *   It only ever creates. An existing credential is never touched, so the
 *   variable cannot be used to overwrite a password somebody has since chosen,
 *   and leaving it set after the first sign-in does nothing.
 *
 *   It runs for one address. Anything else short-circuits before touching the
 *   database, so the ordinary sign-in path costs nothing.
 *
 *   It creates a standing password, deliberately. An earlier version forced a
 *   change at first sign-in, which is the safer default and the wrong one
 *   here: the point of this account is that somebody can sign in with a known
 *   password without a round trip. That trade is the reason the value lives in
 *   the environment rather than in a migration, where it would be both
 *   standing and public.
 */
export async function ensureBootstrapAdmin(store: Store, email: string, venueId: string): Promise<void> {
  const wanted = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!wanted || !password || wanted !== email.toLowerCase()) return;

  if (await store.credentials.get(wanted)) return;

  // upsertStaff conflicts on the address and sets active, so this reinstates a
  // deactivated row rather than making a second one, and needs no read first.
  const existing = (await store.auth.listStaff()).find((s) => s.email.toLowerCase() === wanted);
  await store.auth.upsertStaff({
    email: wanted,
    displayName: existing?.displayName || process.env.ADMIN_BOOTSTRAP_NAME?.trim() || 'Alchemy admin',
    role: 'admin',
    venueIds: existing?.venueIds.length ? existing.venueIds : [venueId],
  });

  await store.credentials.setPassword({
    email: wanted,
    passwordHash: await hashPassword(password),
    mustChange: false,
  });

  console.log(`[member-booking] bootstrapped the admin sign-in for ${wanted} from the environment`);
}
