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

/** Filled from the server's own constants, so the two never drift apart. */
let box = { width: 1000, height: 400 };

/** The pad on the page, while there is one to read at signing time. */
let pad = null;

async function load() {
  if (!token) {
    content.innerHTML = '';
    notice(messages, 'warn', 'This link is incomplete. Open it from your email.');
    return;
  }

  try {
    const data = await api.get(`/api/waiver?token=${encodeURIComponent(token)}`);
    if (data.signatureBox) box = data.signatureBox;
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

  const signed = waiver.status === 'signed' && waiver.signature
    ? el('section', { class: 'card' }, [
        el('label', { text: 'Signed' }),
        el('p', { class: 'muted', style: 'margin:-4px 0 12px', text: waiver.guestName }),
        signatureImage(waiver.signature, box),
      ])
    : null;

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

  if (waiver.status === 'signed') {
    if (signed) content.append(signed);
    return;
  }

  pad = signaturePad(box);

  content.append(
    el('section', { class: 'card stack' }, [
      el('div', {}, [
        el('label', { for: 'signed-name', text: 'Your full name' }),
        el('input', { id: 'signed-name', type: 'text', autocomplete: 'name', placeholder: waiver.guestName }),
      ]),
      el('div', {}, [
        el('label', { text: 'Your signature' }),
        pad.node,
      ]),
      el('label', { class: 'consent' }, [
        el('input', { id: 'agreed', type: 'checkbox' }),
        el('span', { text: text.declaration }),
      ]),
      el('button', { class: 'btn-primary', id: 'sign', type: 'button', text: 'Sign waiver' }),
    ]),
  );

  document.getElementById('sign').addEventListener('click', sign);
}

async function sign() {
  const button = document.getElementById('sign');
  const signedName = document.getElementById('signed-name').value.trim();
  const agreed = document.getElementById('agreed').checked;

  if (!signedName) return notice(messages, 'warn', 'Please type your full name.');
  if (!pad || pad.isEmpty()) return notice(messages, 'warn', 'Please sign in the box above.');
  if (!agreed) return notice(messages, 'warn', 'Please tick the box to confirm you agree.');

  button.disabled = true;
  button.textContent = 'Signing…';
  try {
    const result = await api.post('/api/waiver', { token, signedName, signature: pad.path(), agreed: true });
    notice(messages, 'good', result.message);
    await load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    notice(messages, 'bad', error.message);
    button.disabled = false;
    button.textContent = 'Sign waiver';
  }
}

/**
 * The signature pad.
 *
 * Points are captured in the pad's own pixels and written out in a fixed
 * 1000x400 space, which is why the CSS holds the pad to that aspect ratio: a
 * signature drawn on a phone and one drawn on a laptop come back the same
 * shape. What leaves here is SVG path data, integers only, so the server can
 * check the whole of it against one pattern and the page can draw it back
 * without ever handling markup.
 */
function signaturePad({ width, height }) {
  const canvas = el('canvas', { class: 'sigpad__canvas', 'aria-label': 'Signature pad' });
  const hint = el('span', { class: 'sigpad__hint', text: 'Sign here' });
  const clear = el('button', { class: 'sigpad__clear', type: 'button', text: 'Clear' });
  const pad = el('div', { class: 'sigpad' }, [canvas, hint, clear]);

  const strokes = [];
  let current = null;
  let ctx = null;

  function fit() {
    // A canvas has two sizes: the box on the page and the pixels behind it.
    // Backing the box at the screen's own density is what keeps the line from
    // looking like a staircase on a phone.
    const scale = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round(box.height * scale);
    ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    redraw(box);
  }

  function redraw(box) {
    if (!ctx) return;
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.strokeStyle = getComputedStyle(pad).getPropertyValue('--ink') || '#f4efe7';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      ctx.beginPath();
      stroke.forEach((point, index) => {
        const x = (point.x / width) * box.width;
        const y = (point.y / height) * box.height;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A dot on its own draws nothing with lineTo, so give it a length of one.
      if (stroke.length === 1) ctx.lineTo((stroke[0].x / width) * box.width + 0.1, (stroke[0].y / height) * box.height);
      ctx.stroke();
    }
  }

  function at(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.round(Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width * width),
      y: Math.round(Math.min(Math.max(event.clientY - box.top, 0), box.height) / box.height * height),
    };
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    current = [at(event)];
    strokes.push(current);
    hint.hidden = true;
    redraw(canvas.getBoundingClientRect());
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!current) return;
    const point = at(event);
    const last = current[current.length - 1];
    // Skip the pixel-sized jitter a finger produces while resting. It costs
    // nothing visually and keeps the stored path to a sane length.
    if (Math.abs(point.x - last.x) + Math.abs(point.y - last.y) < 4) return;
    current.push(point);
    redraw(canvas.getBoundingClientRect());
  });

  const end = () => { current = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  clear.addEventListener('click', () => {
    strokes.length = 0;
    current = null;
    hint.hidden = false;
    redraw(canvas.getBoundingClientRect());
  });

  // The pad reflows with the window, and the drawing has to come with it.
  const observer = new ResizeObserver(() => fit());
  observer.observe(canvas);
  requestAnimationFrame(fit);

  return {
    node: pad,
    /** True until there is a stroke with actual length: one tap is not a signature. */
    isEmpty: () => !strokes.some((stroke) => stroke.length > 1),
    path: () => strokes
      .filter((stroke) => stroke.length > 1)
      .map((stroke) => stroke.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(''))
      .join(''),
  };
}

/** Draws a stored signature back, as an image of what was signed. */
function signatureImage(path, { width, height }) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'sigshow__ink');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Your signature');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', path);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '4');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return el('div', { class: 'sigshow' }, [svg]);
}

load();
