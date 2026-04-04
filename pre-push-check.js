#!/usr/bin/env node
/**
 * pre-push-check.js
 * Validates index.html before any push to origin.
 * Exit 0 = clean. Exit 1 = problems found (push blocked).
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.html');
const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';

let errors = 0;

function check(label, fn) {
  const result = fn();
  if (result === true) {
    console.log(`  ${PASS}  ${label}`);
  } else {
    console.log(`  ${FAIL}  ${label}`);
    console.log(`       → ${result}`);
    errors++;
  }
}

// ── Read file ──────────────────────────────────────────────────────────────
if (!fs.existsSync(FILE)) {
  console.error(`\x1b[31mERROR: index.html not found at ${FILE}\x1b[0m`);
  process.exit(1);
}

const html = fs.readFileSync(FILE, 'utf8');
const lines = html.split('\n');
const lineCount = lines.length;

// HTML-only portion (before <script) for branding checks — avoids
// flagging the IS_DEV runtime string '[DEV]' inside the script block.
const htmlOnly = html.split('<script')[0];

console.log('\n\x1b[1mAlchemy Saunas — pre-push validation\x1b[0m');
console.log(`  Checking index.html (${lineCount} lines)\n`);

// ── Branding checks (these should NOT exist) ──────────────────────────────
console.log('\x1b[1mBranding\x1b[0m');

check('[DEV] hardcoded in HTML markup', () => {
  // Only checks HTML portion — the IS_DEV JS runtime string is intentional
  const match = htmlOnly.match(/\[DEV\]/);
  if (match) return `Found "[DEV]" hardcoded in HTML — use IS_DEV flag instead`;
  return true;
});

check('"Alchemy HQ" absent', () => {
  const match = html.match(/Alchemy HQ/);
  if (match) return `Found "Alchemy HQ" — production name should be "Alchemy Saunas"`;
  return true;
});

check('ws-rail references absent', () => {
  const match = html.match(/ws-rail/);
  if (match) return `Found "ws-rail" — leftover icon bar reference, should be removed`;
  return true;
});

// ── Feature presence checks ───────────────────────────────────────────────
console.log('\n\x1b[1mFeature presence\x1b[0m');

check('nexus agent defined', () => {
  return html.includes('nexus:') || html.includes("id:'nexus'") ? true
    : 'nexus agent definition not found';
});

check('sdmCheck function exists', () => {
  return html.includes('function sdmCheck') ? true
    : '"function sdmCheck" not found — cowork deep-mode feature may be missing';
});

check('onboarding screen exists', () => {
  return html.includes('onboardingScreen') ? true
    : '"onboardingScreen" not found — first-run onboarding feature missing';
});

check('toggleSidebar function exists', () => {
  return html.includes('function toggleSidebar') ? true
    : '"function toggleSidebar" not found — sidebar toggle feature missing';
});

check('deep-mode button exists', () => {
  return html.includes('deep-mode-btn') ? true
    : '"deep-mode-btn" not found — deep mode UI feature missing';
});

check('IS_DEV environment detection exists', () => {
  return html.includes('IS_DEV') ? true
    : '"IS_DEV" not found — environment detection not present';
});

// ── File size sanity check ────────────────────────────────────────────────
console.log('\n\x1b[1mFile integrity\x1b[0m');

check(`File size adequate (${lineCount} lines, need >1500)`, () => {
  return lineCount > 1500 ? true
    : `Only ${lineCount} lines — file may be truncated or missing features (expected >1500)`;
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (errors === 0) {
  console.log('\x1b[32m\x1b[1mAll checks passed. Safe to push.\x1b[0m\n');
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m${errors} check(s) failed. Push blocked.\x1b[0m\n`);
  process.exit(1);
}
