import { api, el } from '/api.js';

/**
 * The site header, in two flavours from one implementation.
 *
 * mountNav() is the member header: Book, and My account once signed in. It
 * carries no staff links at all. A member who opens the menu and finds
 * "Settings" either clicks it and lands somewhere confusing, or learns the
 * venue's admin lives one tap from their booking screen. Neither is wanted,
 * and the door list is not a thing to advertise. Staff reach their pages by
 * going to /admin/ directly, which is a sign-in page.
 *
 * mountAdminNav() is the staff header, used only inside the admin area. It
 * appears once somebody is signed in as staff, so the sign-in page itself
 * stays bare.
 *
 * The hamburger is a real <button> with aria-expanded and aria-controls, and
 * the panel is toggled with the [hidden] attribute rather than a class, so the
 * markup is correct for a screen reader even before this script runs. Escape
 * closes it, a click outside closes it, and following a link closes it: on a
 * phone at a door, a menu that stays open over the list is worse than no menu.
 */

const MEMBER_LINKS = [
  { href: '/booking.html', label: 'Book' },
  { href: '/account.html', label: 'My account', needs: 'member' },
];

const ADMIN_LINKS = [
  // Door list first: it is the only one of these anybody opens mid-shift.
  { href: '/doorlist.html', label: 'Door list' },
  { href: '/admin/settings.html', label: 'Settings', roles: ['admin', 'manager'] },
  { href: '/admin/waiver.html', label: 'Waiver', roles: ['admin', 'manager'] },
  { href: '/admin/people.html', label: 'People', roles: ['admin'] },
  { href: '/admin/audit.html', label: 'Audit', roles: ['admin', 'manager'] },
];

export function mountNav() {
  return mount({ home: '/booking.html', links: MEMBER_LINKS });
}

export function mountAdminNav() {
  return mount({ home: '/admin/', links: ADMIN_LINKS, admin: true });
}

function mount({ home, links, admin = false }) {
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

  const wordmark = el('a', { class: 'wordmark', href: home }, [
    'Alchemy ',
    el('span', { text: 'Saunas' }),
  ]);

  host.append(
    el('div', { class: 'site-header__bar' }, [
      admin ? el('div', { class: 'row', style: 'gap:10px' }, [
        wordmark,
        el('span', { class: 'nav-area', text: 'Admin' }),
      ]) : wordmark,
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

  const draw = (session) => render({ list, who, toggle, links, admin, session });
  draw(null);
  // Failing to load the session is not worth a message: the links are a
  // convenience, and every page already handles being signed out on its own.
  api.get('/api/auth/session').then(draw).catch(() => {});

  return { setOpen, refresh: () => api.get('/api/auth/session').then(draw).catch(() => {}) };
}

function render({ list, who, toggle, links, admin, session }) {
  const here = window.location.pathname;
  const staff = session?.staff ?? null;
  const member = session?.member ?? null;

  const visible = links.filter((link) => {
    if (admin) return staff ? !link.roles || link.roles.includes(staff.role) : false;
    return link.needs === 'member' ? Boolean(member) : true;
  });

  list.innerHTML = '';
  for (const link of visible) {
    const anchor = el('a', { href: link.href, text: link.label });
    if (here === link.href || (here === '/' && link.href === '/booking.html')) {
      anchor.setAttribute('aria-current', 'page');
    }
    list.append(anchor);
  }

  who.textContent = admin
    ? (staff ? `${staff.name}, ${staff.role}` : '')
    : (member ? member.name : '');
  who.hidden = !who.textContent;

  // Nothing to open is worse than an empty panel: on the admin sign-in page
  // the button would toggle a blank sheet over the form.
  toggle.hidden = visible.length === 0 && !who.textContent;
}
