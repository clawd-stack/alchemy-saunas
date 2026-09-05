import { api, el, notice } from '/ui.js';
import { mountNav } from '/nav.js';
import { mountSignIn, showPasswordChange } from '/signin.js';
import { renderForm, renderSummary } from '/admin/config.js';
import { renderMembers } from '/admin/members.js';
import { renderCredentials } from '/admin/accounts.js';
import { renderStaff } from '/admin/staff.js';
import { renderAudit } from '/admin/audit.js';

mountNav();

/**
 * The admin screen is a shell. Each section owns its own loading, failure and
 * refresh, so one section being down does not blank the others: an admin whose
 * Hapana key is missing still needs the settings form to set it.
 */

const messages = document.getElementById('messages');
const signinCard = document.getElementById('signin-card');
const adminSection = document.getElementById('admin-section');

mountSignIn({
  formId: 'signin-form',
  buttonId: 'signin-button',
  emailId: 'email',
  passwordId: 'password',
  messages,
  onSignedIn: load,
});

async function load() {
  let data;
  try {
    data = await api.get('/api/admin/config');
  } catch (error) {
    if (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN') {
      signinCard.classList.remove('hidden');
      adminSection.classList.add('hidden');
      return;
    }
    return notice(messages, 'bad', error.message);
  }

  signinCard.classList.add('hidden');
  adminSection.classList.remove('hidden');

  const warnings = document.getElementById('warnings');
  warnings.innerHTML = '';
  for (const warning of data.warnings) {
    warnings.append(el('div', { class: 'notice notice--warn', text: warning }));
  }

  renderSummary(document.getElementById('capacity-summary'), data.config);
  renderForm(document.getElementById('config-form'), data.config, data.entries, { messages, onSaved: load });
  renderOwnAccount();
  renderEmailCheck();

  // Each section refreshes only itself. A cancelled booking should not
  // re-render the settings form under the admin's cursor.
  refresh('members', renderMembers);
  refresh('credentials', renderCredentials);
  refresh('staff', renderStaff);
  renderAudit(document.getElementById('audit'));
}

function refresh(id, render) {
  const host = document.getElementById(id);
  const reload = () => render(host, { messages, reload });
  return reload();
}

function renderOwnAccount() {
  const host = document.getElementById('own-account');
  host.innerHTML = '';

  const change = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Change password' });
  change.addEventListener('click', () => showPasswordChange({ messages, onDone: load }));

  const out = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Sign out' });
  out.addEventListener('click', async () => {
    await api.post('/api/auth/session', {});
    location.reload();
  });

  host.append(el('div', { class: 'row row--tight' }, [change, out]));
}

/**
 * Email fails quietly everywhere else so a send cannot take a booking down
 * with it. This is the one place that says plainly whether it works.
 */
function renderEmailCheck() {
  const host = document.getElementById('email-check');
  host.innerHTML = '';

  const button = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Send test email' });
  const result = el('div');

  button.addEventListener('click', async () => {
    button.disabled = true;
    result.innerHTML = '';
    try {
      const outcome = await api.post('/api/admin/test-email', {});
      notice(result, outcome.ok ? 'good' : 'warn', outcome.message);
      if (outcome.error) result.append(el('p', { class: 'hint', text: outcome.error }));
    } catch (error) {
      notice(result, 'bad', error.message);
    } finally {
      button.disabled = false;
    }
  });

  host.append(el('div', { class: 'row row--between' }, [el('strong', { text: 'Email' }), button]), result);
}

load();
