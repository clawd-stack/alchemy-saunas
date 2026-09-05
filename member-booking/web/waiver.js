import { api, el, notice } from '/api.js';
import { mountNav } from '/nav.js';

mountNav();

/**
 * Guest waiver page.
 *
 * The token arrives in the URL fragment rather than the query string, so it is
 * never sent to the server as part of a navigation and does not end up in
 * access logs or a Referer header. The page reads it and posts it explicitly.
 */

const messages = document.getElementById('messages');
const content = document.getElementById('content');

const token = location.hash.slice(1);

async function load() {
  if (!token) {
    content.innerHTML = '';
    notice(messages, 'warn', 'This link is incomplete. Open it from your email.');
    return;
  }

  try {
    const data = await api.get(`/api/waiver?token=${encodeURIComponent(token)}`);
    render(data);
  } catch (error) {
    content.innerHTML = '';
    notice(
      messages,
      'warn',
      error.code === 'NOT_FOUND'
        ? 'This link is no longer valid. You can sign at the venue.'
        : error.message,
    );
  }
}

function render(data) {
  const { waiver, text } = data;
  document.getElementById('title').textContent = text.title;
  content.innerHTML = '';
  content.append(
    el('p', { class: 'sub', style: 'margin:-16px 0 24px', text: `${waiver.guestName} · ${waiver.sessionLabel}` }),
  );

  if (text.placeholder) {
    // Better to say so plainly than to let anyone believe placeholder text is
    // a signed liability document.
    notice(messages, 'warn', 'This waiver is still draft wording and is not yet the final legal text.');
  }

  if (waiver.status === 'signed') {
    notice(messages, 'good', `Signed on ${new Date(waiver.signedAt).toLocaleString('en-AU')}. Nothing further to do.`);
  }

  const termsLink = text.termsUrl
    ? el('p', { style: 'margin:0 0 20px' }, [
        el('a', {
          href: text.termsUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: 'color:var(--accent);font-weight:600',
        }, [text.termsLabel || 'Read the full Terms of Use']),
      ])
    : null;

  const clauses = text.clauses.map((clause) =>
    el('div', { style: 'margin-bottom:16px' }, [
      el('strong', { text: clause.heading }),
      el('p', { class: 'muted', style: 'margin:4px 0 0', text: clause.body }),
    ]),
  );

  content.append(
    el('section', { class: 'card' }, [
      el('p', { class: 'muted', style: 'margin-top:0', text: text.intro }),
      termsLink,
      ...clauses,
    ]),
  );

  if (waiver.status === 'signed') return;

  content.append(
    el('section', { class: 'card stack' }, [
      el('div', {}, [
        el('label', { for: 'signed-name', text: 'Type your full name to sign' }),
        el('input', { id: 'signed-name', type: 'text', autocomplete: 'name', placeholder: waiver.guestName }),
      ]),
      el('label', { style: 'font-weight:400; display:flex; gap:10px; align-items:flex-start' }, [
        el('input', { id: 'agreed', type: 'checkbox', style: 'width:auto; margin-top:4px' }),
        el('span', { text: text.declaration }),
      ]),
      el('button', { class: 'btn-primary', id: 'sign', type: 'button', text: 'Sign waiver' }),
      el('p', { class: 'hint', text: 'Prefer to sign in person? The team can sort it out at the door.' }),
    ]),
  );

  document.getElementById('sign').addEventListener('click', sign);
}

async function sign() {
  const button = document.getElementById('sign');
  const signedName = document.getElementById('signed-name').value.trim();
  const agreed = document.getElementById('agreed').checked;

  if (!signedName) return notice(messages, 'warn', 'Please type your full name to sign.');
  if (!agreed) return notice(messages, 'warn', 'Please tick the box to confirm you agree.');

  button.disabled = true;
  button.textContent = 'Signing…';
  try {
    const result = await api.post('/api/waiver', { token, signedName, agreed: true });
    notice(messages, 'good', result.message);
    await load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    notice(messages, 'bad', error.message);
    button.disabled = false;
    button.textContent = 'Sign waiver';
  }
}

load();
