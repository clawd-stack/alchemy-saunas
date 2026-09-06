/**
 * Reads a membership export.
 *
 * Its own module, with no imports, because the interesting part is not the
 * screen: it is what happens to a file somebody exported from a system nobody
 * here can see. Quoted commas, a byte order mark from Excel, CRLF endings, a
 * tab separated file saved as .csv, a header spelled "Email Address" instead
 * of "email". Each of those is a real file, and each is a test.
 */

/** Header spellings worth recognising, in the order they are preferred. */
const COLUMNS = {
  email: ['email', 'email address', 'emailaddress', 'e-mail', 'primary email', 'member email'],
  firstName: ['first name', 'firstname', 'given name', 'first'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'last'],
  name: ['name', 'full name', 'member name', 'member', 'client name'],
  status: ['status', 'membership status', 'member status', 'account status', 'state'],
  // "package name" first, and ahead of "package type": Hapana's active
  // membership report carries both, and the type column reads "Membership"
  // on every row while the name is the thing being ruled on.
  membershipType: [
    'package name', 'membership package', 'membership name', 'membership type',
    'plan name', 'product name', 'package', 'membership', 'member type',
    'plan', 'product', 'contract', 'package type',
  ],
};

/**
 * Reads a CSV, or anything close enough to one.
 *
 * Tab separated files come out of a spreadsheet often enough to be worth
 * accepting, so the delimiter is whichever of tab and comma appears more often
 * in the header line.
 */
export function parseExport(text) {
  const clean = String(text ?? '').replace(/^﻿/, '').trim();
  if (!clean) throw new Error('There is nothing to read yet.');

  const delimiter = (clean.split('\n')[0].match(/\t/g) ?? []).length >
    (clean.split('\n')[0].match(/,/g) ?? []).length ? '\t' : ',';

  const grid = parseDelimited(clean, delimiter);
  if (grid.length < 2) throw new Error('That file has a header row and nothing else.');

  const header = grid[0].map((cell) => cell.trim().toLowerCase());
  const headers = {};
  const index = {};
  for (const [field, candidates] of Object.entries(COLUMNS)) {
    const position = candidates.map((c) => header.indexOf(c)).find((i) => i !== -1);
    if (position !== undefined) {
      index[field] = position;
      headers[field] = grid[0][position].trim();
    }
  }
  if (index.email === undefined) {
    throw new Error(`No email column found. Columns read: ${grid[0].join(', ')}`);
  }

  const rows = [];
  for (const line of grid.slice(1)) {
    if (line.every((cell) => cell.trim() === '')) continue;
    const at = (field) => (index[field] === undefined ? '' : (line[index[field]] ?? '').trim());
    rows.push({
      email: at('email'),
      firstName: at('firstName'),
      lastName: at('lastName'),
      name: at('name'),
      status: at('status'),
      membershipType: at('membershipType'),
    });
  }

  return { rows, headers };
}

/** A quoted-field CSV reader. Small, and correct about "" inside a quoted field. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
