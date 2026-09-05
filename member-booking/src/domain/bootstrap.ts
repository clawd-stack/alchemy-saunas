import { hashPassword, verifyPassword } from '../lib/password.ts';
import type { Store } from '../store/types.ts';

/**
 * The named admin, reconciled from the environment on every sign-in attempt
 * for that one address.
 *
 * Seeding an admin password in a migration puts its hash in the repository,
 * and this repository is public. scrypt makes that expensive to attack rather
 * than impossible, and the hash stays valid until somebody changes the
 * password, which is not a property to hand out with a git clone. Migration
 * 007 does exactly that for the existing bootstrap account and should be
 * treated as compromised until that password is changed.
 *
 * An earlier version of this created the account and then never touched it
 * again. That was wrong against a database with history rather than a fresh
 * migration run: any credential row already sitting on the address, from a
 * password issued earlier or a half-finished attempt, made every later run a
 * no-op, and the variable in the environment silently meant nothing. Sign-in
 * refuses identically for every reason, so from outside it looked exactly like
 * a mistyped password, with nothing to distinguish them.
 *
 * So it reconciles instead. While the two variables are set, that address's
 * password IS the value in ADMIN_BOOTSTRAP_PASSWORD, and its staff row is an
 * active admin. Both are made true on every attempt, which is deterministic,
 * self-healing, and costs one hash verification on one address.
 *
 * The consequence is worth stating plainly: a password chosen in the app is
 * overwritten on the next sign-in while the variable is still set. To own the
 * password from the app instead, remove ADMIN_BOOTSTRAP_PASSWORD; this then
 * does nothing at all.
 */
export async function ensureBootstrapAdmin(store: Store, email: string, venueId: string): Promise<void> {
  const wanted = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!wanted || !password || wanted !== email.toLowerCase()) return;

  // The staff row first. A correct password on an address with no active staff
  // row falls through to the membership lookup and is refused anyway, which is
  // the same failure wearing a different hat.
  const staff = (await store.auth.listStaff()).find((s) => s.email.toLowerCase() === wanted);
  if (!staff || !staff.active || staff.role !== 'admin') {
    // upsertStaff conflicts on the address and sets active, so this reinstates
    // a deactivated row rather than making a second one.
    await store.auth.upsertStaff({
      email: wanted,
      displayName: staff?.displayName || process.env.ADMIN_BOOTSTRAP_NAME?.trim() || 'Alchemy admin',
      role: 'admin',
      venueIds: staff?.venueIds.length ? staff.venueIds : [venueId],
    });
    console.log(`[member-booking] bootstrap: reinstated the admin staff row for ${wanted}`);
  }

  // The flag counts as much as the hash. A credential written by an earlier
  // deploy carries must_change, and checking only the password left that
  // stuck on: correct password, so nothing to do, so the prompt came back on
  // every sign-in forever. What the environment describes is a standing
  // password that does not want changing, and both halves say so.
  const existing = await store.credentials.get(wanted);
  if (
    existing?.active &&
    !existing.mustChange &&
    (await verifyPassword(password, existing.passwordHash))
  ) {
    return;
  }

  await store.credentials.setPassword({
    email: wanted,
    passwordHash: await hashPassword(password),
    // A standing password, deliberately: the point of this account is that
    // somebody can sign in with a known one without a round trip.
    mustChange: false,
  });
  console.log(
    `[member-booking] bootstrap: ${existing ? 'reset' : 'created'} the sign-in for ${wanted} from the environment`,
  );
}
