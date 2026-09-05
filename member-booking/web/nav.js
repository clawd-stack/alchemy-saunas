import { api, el } from '/api.js';

/**
 * The site header, shared by every page.
 *
 * One nav rather than four copies, because the links change with who is signed
 * in and four copies would drift. It renders immediately from the page it is on
 * and then fills in the rest once /api/auth/session answers, so the header is
 * never blank while a request is in flight.
 *
 * The hamburger is a real <button> with aria-expanded and aria-controls, and
 * the panel is toggled with the [hidden] attribute rather than a class, so the
 * markup is correct for a screen reader even before this script runs. Escape
 * closes it, a click outside closes it, and following a link closes it: on a
 * phone at a door, a menu that stays open over the list is worse than no menu.
 */

const LINKS = {
  booking: { href: '/booking.html', label: 'Book' },
  account: { href: '/account.html', label: 'My account' },
  doorlist: { href: '/doorlist.html', label: 'Door list' },
  admin: { href: '/admin.html', label: 'Settings' },
};

export function mountNav() {
  const host = document.getElementById('site-header');
  if (!host) return;

  const toggle = el('button', {
    class: 'nav-toggle',
    type: 'button',
    id: 'nav-toggle',
    'aria-label': 'Menu',
    'aria-expanded': 'false',
    'aria-controls': 'site-nav',
  }, [el('span', { class: 'nav-toggle__box' }, [el('i'), el('i'), el('i')])]);

  const list = el('ul', { class: 'nav-links' });
  const who = el('span', { class: 'nav-who' });
  const nav = el('nav', { class: 'site-nav', id: 'site-nav', 'aria-label': 'Main' }, [list, who]);
  nav.hidden = true;

  host.append(
    el('div', { class: 'site-header__bar' }, [
      el('a', { class: 'wordmark', href: '/booking.html' }, [
        'Alchemy ',
        el('span', { text: 'Saunas' }),
      ]),
      el('div', { class: 'row', style: 'gap:8px' }, [nav, toggle]),
    ]),
  );

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    // Only meaningful below the breakpoint; above it the stylesheet keeps the
    // nav visible regardless, so this is safe to leave set either way.
    nav.hidden = !open;
  };

  toggle.addEventListener('click', () => setOpen(!isOpen()));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (isOpen() && !host.contains(event.target)) setOpen(false);
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  render(list, who, null);
  // Failing to load the session is not worth a message: the links are a
  // convenience, and every page already handles being signed out on its own.
  api.get('/api/auth/session')
    .then((session) => render(list, who, session))
    .catch(() => {});

  return { setOpen };
}

function render(list, who, session) {
  const here = window.location.pathname;
  const staff = session?.staff ?? null;
  const member = session?.member ?? null;

  const visible = [LINKS.booking];

  // A signed-in member gets their own account; there is nothing there for a
  // member who is not signed in, and a dead link is worse than no link.
  if (member) visible.push(LINKS.account);

  if (staff) {
    visible.push(LINKS.doorlist);
    if (staff.role === 'admin' || staff.role === 'manager') visible.push(LINKS.admin);
  } else if (!member) {
    // Signed out entirely, the staff pages still have to be reachable:
    // somebody has to be able to get to a sign-in form. They are
    // authenticated on the server, so listing them reveals nothing.
    visible.push(LINKS.doorlist, LINKS.admin);
  }

  list.innerHTML = '';
  for (const link of visible) {
    const anchor = el('a', { href: link.href, text: link.label });
    if (here === link.href || (here === '/' && link.href === '/booking.html')) {
      anchor.setAttribute('aria-current', 'page');
    }
    list.append(anchor);
  }

  who.textContent = staff
    ? `${staff.name}, ${staff.role}`
    : member
      ? member.name
      : '';
  who.hidden = !staff && !member;
}
