import { api, el, load, table } from '/ui.js';

/** Every booking, cancellation and refusal, with occupancy at the time. */
export async function renderAudit(host) {
  await load(host, null, async () => {
    const data = await api.get('/api/admin/audit');
    if (data.rows.length === 0) return [el('p', { class: 'muted', text: 'Nothing in the last seven days.' })];

    const shown = Math.min(60, data.rows.length);

    return [
      data.ceilingBreaches > 0 ? el('div', {
        class: 'notice notice--bad',
        text: data.ceilingBreaches === 1
          ? 'One entry shows occupancy above the venue maximum.'
          : `${data.ceilingBreaches} entries show occupancy above the venue maximum.`,
      }) : null,
      el('div', { class: 'row row--between' }, [
        el('p', { class: 'muted', style: 'margin:0', text: `Showing ${shown} of ${data.rows.length} entries.` }),
        el('button', {
          class: 'btn-quiet btn-small', type: 'button', text: 'Export CSV',
          onclick: () => download(csv(data.rows), filename(data)),
        }),
      ]),
      table(['When', 'Action', 'Spots', 'Channel', 'Venue'],
        data.rows.slice(-60).reverse().map((row) => el('tr', {}, [
          el('td', { class: 'muted', text: new Date(row.createdAt).toLocaleString('en-AU') }),
          el('td', { text: row.refusalCode ? `${row.action} (${row.refusalCode})` : row.action }),
          el('td', { text: String(row.spotsDelta) }),
          el('td', { text: `${row.memberChannelBookedAfter}/${row.memberChannelCapacity}` }),
          el('td', { text: `${row.venueTotalBookedAfter}/${row.venueMaximumAtTime ?? '–'}` }),
        ]))),
    ];
  });
}

/**
 * The whole range, not the sixty rows on screen: the table is for a glance,
 * the export is for the spreadsheet somebody takes away and works in.
 */
const COLUMNS = [
  ['When', (row) => new Date(row.createdAt).toLocaleString('en-AU')],
  ['Timestamp (UTC)', (row) => row.createdAt],
  ['Action', (row) => row.action],
  ['Refusal code', (row) => row.refusalCode ?? ''],
  ['Spots', (row) => row.spotsDelta],
  ['Member channel booked after', (row) => row.memberChannelBookedAfter],
  ['Member channel capacity', (row) => row.memberChannelCapacity],
  ['Public booked at time', (row) => row.publicBookedAtTime],
  ['Venue total booked after', (row) => row.venueTotalBookedAfter],
  ['Venue maximum at time', (row) => row.venueMaximumAtTime ?? ''],
  ['Session', (row) => row.sessionId],
  ['Booking', (row) => row.bookingId ?? ''],
  ['Event', (row) => row.eventId],
];

function csv(rows) {
  const lines = [COLUMNS.map(([heading]) => cell(heading)).join(',')];
  for (const row of rows) lines.push(COLUMNS.map(([, read]) => cell(read(row))).join(','));
  // A BOM, so Excel opens it as UTF-8 rather than mangling anything accented.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function cell(value) {
  if (value === null || value === undefined) return '';
  // Numbers go out as numbers. A cancellation is -3 spots, and quoting that as
  // text would leave a column nothing can be summed on.
  if (typeof value === 'number') return String(value);

  let text = String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // None of these fields should ever start with one, and if a future one does,
  // it stays text rather than becoming something that runs on open.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function filename(data) {
  const day = (value) => new Date(value).toISOString().slice(0, 10);
  return `alchemy-capacity-audit-${day(data.from)}-to-${day(data.to)}.csv`;
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  // Held until the browser has taken the blob, then released.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
