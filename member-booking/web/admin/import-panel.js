import { api, el, notice } from '/ui.js';
import { parseExport } from '/admin/export-reader.js';

/**
 * Import a membership export.
 *
 * The venue produces the file from Hapana: this service has no way to fetch
 * it, and it does not need one. What it needs is for the file to become member
 * rows without anybody retyping four hundred addresses.
 *
 * Parsing happens here rather than on the server so the columns can be guessed
 * and shown back before anything is sent, and so what does get sent is a
 * normalised list the endpoint can check field by field. Nothing is written
 * until Apply: Preview asks for the plan and shows exactly what would change.
 *
 * Everybody in the file is imported. The packages found are listed because it
 * is worth seeing what is in a file before applying it, but they are not a
 * filter: which packages can book is one decision, made on the switches below
 * this panel and applied at sign-in, rather than a decision re-made on every
 * import and frozen into who happens to have been imported since.
 */

export function importPanel({ messages, reload }) {
  const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  const paste = el('textarea', {
    rows: '6',
    placeholder: 'or paste the export here, including its header row',
    spellcheck: 'false',
  });
  const typesHost = el('div', { hidden: 'hidden' });
  const planHost = el('div', {});

  const preview = el('button', { class: 'btn-quiet btn-inline', type: 'button', text: 'Preview' });
  const apply = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Apply', disabled: 'disabled' });
  const deactivate = el('input', { type: 'checkbox' });

  let parsed = null;   // { rows, headers }

  file.addEventListener('change', async () => {
    const chosenFile = file.files?.[0];
    if (!chosenFile) return;
    paste.value = await chosenFile.text();
    handleParse();
  });
  paste.addEventListener('change', handleParse);

  function handleParse() {
    planHost.innerHTML = '';
    apply.disabled = true;
    try {
      parsed = parseExport(paste.value);
    } catch (error) {
      parsed = null;
      typesHost.hidden = true;
      return notice(messages, 'bad', error.message);
    }
    notice(messages, 'info',
      `${parsed.rows.length} rows read. Columns used: ${Object.entries(parsed.headers)
        .map(([field, header]) => `${field} from "${header}"`).join(', ')}.`);
    drawTypes();
  }

  function drawTypes() {
    const counts = new Map();
    for (const row of parsed.rows) {
      const type = row.membershipType || 'No package named';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    typesHost.innerHTML = '';
    typesHost.hidden = counts.size === 0;
    if (counts.size === 0) return;

    typesHost.append(
      el('label', { text: 'Packages in this file' }),
      el('div', { class: 'stack' }, [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => el('p', { class: 'row row--between', style: 'margin:0' }, [
          el('span', { text: type }),
          el('span', { class: 'muted', style: 'white-space:nowrap', text: `${count}` }),
        ]))),
      el('p', { class: 'hint', style: 'margin:6px 0 0', text:
        'All of them are imported. Which ones can book is set by the switches under Membership packages.' }),
    );
  }

  async function send(shouldApply) {
    if (!parsed) return notice(messages, 'warn', 'Choose a file or paste the export first.');
    const button = shouldApply ? apply : preview;
    button.disabled = true;
    try {
      const result = await api.post('/api/admin/people', {
        action: 'import',
        rows: parsed.rows,
        deactivateMissing: deactivate.checked,
        apply: shouldApply,
      });
      drawPlan(result, shouldApply);
      notice(messages, shouldApply ? 'good' : 'info', result.message);
      if (shouldApply) {
        parsed = null;
        paste.value = '';
        file.value = '';
        typesHost.hidden = true;
        await reload();
      }
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      button.disabled = shouldApply;
      if (!shouldApply) apply.disabled = false;
    }
  }

  function drawPlan(result, applied) {
    const { plan } = result;
    planHost.innerHTML = '';
    planHost.append(
      el('div', { class: 'figures', style: 'margin-top:20px' }, [
        figure(plan.add.length, applied ? 'added' : 'to add'),
        figure(plan.update.length, applied ? 'updated' : 'to update'),
        figure(plan.unchanged, 'already current'),
        figure(plan.missing.length, 'not in this file'),
      ]),
    );

    const notes = [
      plan.skippedStaff.length ? `Skipped, because they are staff: ${plan.skippedStaff.join(', ')}.` : null,
      plan.duplicates ? `${plan.duplicates} duplicate ${plan.duplicates === 1 ? 'address' : 'addresses'}, first kept.` : null,
      plan.invalid ? `${plan.invalid} ${plan.invalid === 1 ? 'row' : 'rows'} had no usable email address.` : null,
    ].filter(Boolean);
    for (const note of notes) planHost.append(el('p', { class: 'hint', text: note }));

    if (plan.missing.length && !applied) {
      planHost.append(el('p', { class: 'hint', text:
        `In the app but not in this file: ${plan.missing.slice(0, 12).map((p) => p.email).join(', ')}` +
        (plan.missing.length > 12 ? `, and ${plan.missing.length - 12} more.` : '.') }));
    }
  }

  function figure(value, label) {
    return el('div', {}, [el('strong', { text: String(value) }), label]);
  }

  preview.addEventListener('click', () => send(false));
  apply.addEventListener('click', () => send(true));

  return el('section', { class: 'stack' }, [
    el('p', { class: 'hint', style: 'margin:0', text:
      'A CSV from Hapana, or any file with an email column. Nothing is written until you press Apply.' }),
    el('div', {}, [el('label', { text: 'File' }), file]),
    paste,
    typesHost,
    el('label', { class: 'consent', style: 'margin-top:8px;padding-top:18px;border-top:1px solid var(--line-2)' }, [
      deactivate,
      el('span', { text: 'Cancel members who are in the app but not in this file' }),
    ]),
    el('div', { class: 'row row--tight' }, [preview, apply]),
    planHost,
  ]);
}
