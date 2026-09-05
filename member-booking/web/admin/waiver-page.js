import { api, el, field, notice } from '/ui.js';
import { mountAdminPage } from '/admin/shell.js';

/**
 * The guest waiver, on its own page.
 *
 * The version is stamped on every signature, so changing the wording and
 * leaving the version alone would leave two different documents recorded
 * under one name. Saving the text bumps the stored version to whatever is in
 * the version box, and the page says so rather than doing it silently.
 */

mountAdminPage({
  roles: ['admin', 'manager'],
  run: async ({ messages }) => {
    const host = document.getElementById('waiver');
    const data = await api.get('/api/admin/config');
    draw(host, data.config, { messages });
  },
});

function draw(host, config, { messages }) {
  const waiver = config.waiverText ?? { clauses: [], declaration: '', termsUrl: '', version: '' };

  const version = el('input', { id: 'waiver_version_field', type: 'text', value: waiver.version ?? '' });
  const terms = el('input', { id: 'waiver_terms_url', type: 'text', value: waiver.termsUrl ?? '' });
  const clauses = el('textarea', { id: 'waiver_clauses', rows: '10' },
    [(waiver.clauses ?? []).map((c) => `${c.heading} | ${c.body}`).join('\n')]);
  const declaration = el('input', { id: 'waiver_declaration', type: 'text', value: waiver.declaration ?? '' });

  const form = el('form', { class: 'stack' }, [
    el('fieldset', { class: 'group' }, [
      el('legend', { text: 'Clauses' }),
      el('div', { class: 'group__fields group__fields--stack' }, [
        field('One per line, written as "Heading | text"', clauses),
        field('Declaration, shown beside the tick box', declaration),
      ]),
    ]),
    el('fieldset', { class: 'group' }, [
      el('legend', { text: 'Identity' }),
      el('div', { class: 'group__fields' }, [
        field('Version, recorded against every signature', version),
        field('Terms of Use link', terms),
      ]),
    ]),
    el('div', { class: 'row row--tight' }, [
      el('button', { class: 'btn-primary btn-inline', type: 'submit', text: 'Save waiver' }),
      el('button', {
        class: 'btn-quiet btn-small', type: 'button', text: 'Reset',
        onclick: () => draw(host, config, { messages }),
      }),
    ]),
  ]);

  form.onsubmit = async (event) => {
    event.preventDefault();

    const next = {
      ...config.waiverText,
      clauses: clauses.value.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const split = line.indexOf('|');
        return split === -1
          ? { heading: '', body: line }
          : { heading: line.slice(0, split).trim(), body: line.slice(split + 1).trim() };
      }),
      termsUrl: terms.value.trim(),
      declaration: declaration.value.trim(),
      version: version.value.trim(),
    };

    if (JSON.stringify(next) === JSON.stringify(config.waiverText)) {
      return notice(messages, 'info', 'Nothing changed.');
    }
    if (!next.version) return notice(messages, 'warn', 'Give the waiver a version.');

    const updates = { waiver_text: next };
    if (next.version !== config.waiverVersion) updates.waiver_version = next.version;

    try {
      const result = await api.patch('/api/admin/config', { updates, sourceNote: null });
      notice(messages, 'good', result.message);
      const fresh = await api.get('/api/admin/config');
      draw(host, fresh.config, { messages });
    } catch (error) {
      const issues = error.payload?.issues ?? null;
      notice(messages, 'bad', issues ? issues.map((i) => i.message).join(' ') : error.message);
    }
  };

  host.innerHTML = '';
  host.append(el('div', { class: 'card card--pad' }, [form]));
}
