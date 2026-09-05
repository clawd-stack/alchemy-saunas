import { api, el, load, table } from '/ui.js';

/** Every booking, cancellation and refusal, with occupancy at the time. */
export async function renderAudit(host) {
  await load(host, null, async () => {
    const data = await api.get('/api/admin/audit');
    if (data.rows.length === 0) return [el('p', { class: 'muted', text: 'Nothing in the last seven days.' })];

    return [
      data.ceilingBreaches > 0 ? el('div', {
        class: 'notice notice--bad',
        text: `${data.ceilingBreaches} entries show occupancy above the venue maximum.`,
      }) : null,
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
