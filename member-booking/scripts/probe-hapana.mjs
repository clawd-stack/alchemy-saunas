#!/usr/bin/env node
/**
 * Hapana API probe.
 *
 * Answers PRD dependency 9.1 (can the API create a booking, which decides
 * Pattern A versus Pattern B) and most of Appendix A.4, in one pass, without
 * contacting Hapana support.
 *
 * It must be run from a machine that can reach Hapana. The build environment
 * used for this project is behind an egress policy that blocks
 * api.hapana.com and apidocs.hapana.com, so this could not be run there.
 *
 * Usage:
 *   HAPANA_API_KEY='<id:secret>' node scripts/probe-hapana.mjs
 *
 * Optional:
 *   HAPANA_BASE_URL   default https://api.hapana.com
 *   HAPANA_SITE_ID    the East Fremantle site id, if known
 *   PROBE_EMAIL       a known member email, to test the lookup path
 *
 * It only ever issues GET requests. It never creates a booking: it establishes
 * whether a create endpoint EXISTS, by reading the endpoint list and by
 * inspecting how the server answers an unauthenticated-shape POST discovery
 * (405 versus 404), and it stops there. Confirm write behaviour deliberately,
 * against a test session, once the endpoint is known.
 */

const KEY = process.env.HAPANA_API_KEY;
const BASE = (process.env.HAPANA_BASE_URL ?? 'https://api.hapana.com').replace(/\/?$/, '/');
const SITE = process.env.HAPANA_SITE_ID ?? '';
const PROBE_EMAIL = process.env.PROBE_EMAIL ?? '';

if (!KEY) {
  console.error('Set HAPANA_API_KEY first. Never paste it into a file in this repository.');
  process.exit(1);
}

/** The auth styles worth trying, in the order they are most likely. */
const AUTH_STYLES = [
  { name: 'x-api-key', apply: (h) => { h['x-api-key'] = KEY; } },
  { name: 'apikey-header', apply: (h) => { h.apikey = KEY; } },
  { name: 'bearer', apply: (h) => { h.authorization = `Bearer ${KEY}`; } },
  { name: 'basic', apply: (h) => { h.authorization = `Basic ${Buffer.from(KEY).toString('base64')}`; } },
];

/** Candidate paths. The real list comes from apidashboard.hapana.com. */
const READ_PATHS = [
  'v1/members', 'v2/members', 'members', 'api/v1/members',
  'v1/clients', 'clients',
  'v1/sessions', 'v2/sessions', 'sessions', 'v1/classes', 'classes',
  'v1/sites', 'sites', 'v1/locations', 'locations',
];

const WRITE_PATHS = [
  'v1/bookings', 'v2/bookings', 'bookings',
  'v1/reservations', 'reservations',
  'v1/class-bookings', 'v1/registrations', 'registrations',
];

async function attempt(path, { style, method = 'GET' }) {
  const url = new URL(path, BASE);
  if (SITE) url.searchParams.set('siteID', SITE);
  const headers = { accept: 'application/json' };
  style.apply(headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, allow: response.headers.get('allow'), body: text.slice(0, 400) };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function heading(text) {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`);
}

const findings = {
  probedAt: new Date().toISOString(),
  baseUrl: BASE,
  authScheme: null,
  canReadMembers: false,
  canReadSessions: false,
  canCreateBookings: false,
  exposesPausedAndSuspended: null,
  hiddenClassesBookableViaApi: null,
  respectsClassCapacity: null,
  webhookEvents: [],
  notes: [],
};

heading('1. Which authentication style does the account accept?');
let workingStyle = null;
for (const style of AUTH_STYLES) {
  const result = await attempt(READ_PATHS[0], { style });
  console.log(`  ${style.name.padEnd(16)} -> ${result.status}${result.error ? ` (${result.error})` : ''}`);
  if (result.status && result.status !== 401 && result.status !== 403 && result.status !== 0) {
    workingStyle = style;
    break;
  }
}

if (!workingStyle) {
  console.log('\n  No style got past authentication on the first path. That is not conclusive:');
  console.log('  the base URL may be wrong. Log into apidashboard.hapana.com and read the');
  console.log('  actual base URL and scheme, then re-run with HAPANA_BASE_URL set.');
  workingStyle = AUTH_STYLES[0];
} else {
  findings.authScheme = workingStyle.name;
  console.log(`\n  Using: ${workingStyle.name}`);
}

heading('2. Which read endpoints answer?');
for (const path of READ_PATHS) {
  const result = await attempt(path, { style: workingStyle });
  const marker = result.ok ? 'OK  ' : '    ';
  console.log(`  ${marker}${String(result.status).padEnd(5)} ${path}`);
  if (result.ok && /member|client/.test(path)) findings.canReadMembers = true;
  if (result.ok && /session|class/.test(path)) findings.canReadSessions = true;
  if (result.ok) console.log(`        ${result.body.replace(/\s+/g, ' ').slice(0, 200)}`);
}

heading('3. Does a booking-creation endpoint exist?');
console.log('  Reading only. A 405 Method Not Allowed on GET, or an Allow header naming');
console.log('  POST, means the path exists and accepts writes. A 404 means it does not.\n');
for (const path of WRITE_PATHS) {
  const result = await attempt(path, { style: workingStyle });
  const allow = result.allow ? ` allow: ${result.allow}` : '';
  console.log(`  ${String(result.status).padEnd(5)} ${path}${allow}`);
  if (result.status === 405 || /POST/i.test(result.allow ?? '')) {
    findings.canCreateBookings = true;
    findings.notes.push(`${path} exists and appears to accept writes (${result.status}${allow}).`);
  }
  if (result.ok) {
    findings.notes.push(`${path} answers GET; check the dashboard for a matching POST.`);
  }
}

heading('4. Membership statuses in the data');
if (PROBE_EMAIL) {
  const result = await attempt(`${READ_PATHS[0]}?email=${encodeURIComponent(PROBE_EMAIL)}`, { style: workingStyle });
  console.log(`  ${result.status}: ${result.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  console.log('\n  Check the payload above for a status field, and whether it distinguishes');
  console.log('  paused and suspended from active and cancelled. PRD 5.1 depends on it.');
} else {
  console.log('  Skipped: set PROBE_EMAIL to a known member address to see a real payload.');
}

heading('Verdict');
if (findings.canCreateBookings) {
  console.log('  Pattern A looks available: Hapana appears to expose booking creation.');
  console.log('  Set booking_backend = "hapana" in the admin config ONLY after confirming,');
  console.log('  against a test session, that:');
  console.log('    - a hidden or unpublished class is still bookable through the API');
  console.log('    - API booking creation respects class capacity rather than exceeding it');
} else {
  console.log('  No booking-creation endpoint was demonstrated. Pattern B applies:');
  console.log('  leave booking_backend = "local". The build ships this way by default,');
  console.log('  so nothing needs to change to go live.');
}

console.log('\n  Paste this block into docs/hapana-findings.md:\n');
console.log(JSON.stringify(findings, null, 2));

console.log('\n  Still to confirm by hand in apidashboard.hapana.com (Appendix A.4):');
console.log('   - the webhook event catalogue, specifically membership status change');
console.log('   - whether an SSO or OAuth flow is usable from an external page (PRD 9.2)');
console.log('   - whether API access is included on the current plan or costs extra');
