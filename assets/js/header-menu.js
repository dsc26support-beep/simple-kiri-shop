// The three-dot overflow menu in the page header.
//
// It exists because the header nav rows had drifted: the homepage carried
// Tips / Create Store / Sign In, stores.html carried Home / Create Store, the
// category page Home / Stores, and the product page Home / Store. Four pages,
// four different answers to "where else can I go", and no room on a phone for
// a fifth link on any of them.
//
// Injected rather than written into each page's markup, for the reason
// header-cart.js gives for doing the same: the headers are not a shared
// component, and keeping six hand-written copies of this list in sync is how
// they drift in the first place.
//
// It is NOT on every page. Checkout, cart and the login pages are deliberately
// without one - a menu beside a payment step is an invitation to leave it.
document.addEventListener('DOMContentLoaded', initHeaderMenu);

const HEADER_MENU_ICON = {
  stores: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"></path><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"></path><path d="M5 11v9h14v-9"></path></svg>',
  categories: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>',
  createStore: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"></path><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"></path><path d="M5 11v9h6"></path><path d="M16 15h6"></path><path d="M19 12v6"></path></svg>',
  help: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.7.7-.7 1.3v.3"></path><path d="M12 17h.01"></path></svg>',
  tips: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.2 1 2.5h6c0-1.3.4-1.9 1-2.5A6 6 0 0 0 12 3z"></path></svg>',
  account: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>',
  recent: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4"></path><path d="M3 4v5h5"></path><path d="M12 8v4l3 2"></path></svg>'
};

const HEADER_MENU_ENQUIRY =
  'mailto:admin@mwakete.com?subject=Mwakete%20Enquiry';

/**
 * The items, in the order they are shown.
 *
 * Two of them are conditional, and both conditions are read from THIS device
 * with no request: a menu that has to wait for the backend before it can be
 * opened is a menu that is wrong for the first second of every page.
 *
 *  - Create Store disappears once this device holds a seller token, the same
 *    rule (and the same check) the homepage nav used before this menu replaced
 *    it.
 *  - Recent Stores appears only when there is something behind it. It is built
 *    from the per-store carts in localStorage - the same list stores.html
 *    shows as "Pick up where you left off" - so with no carts it would be a
 *    link to an empty row.
 */
function headerMenuItems() {
  const hasStore = typeof Auth !== 'undefined' && !!Auth.getToken();
  const hasCustomer = typeof CustomerAuth !== 'undefined' && !!CustomerAuth.getToken();
  const recentCount = typeof cartStoreSlugs === 'function' ? cartStoreSlugs().length : 0;

  const items = [
    { label: 'Stores', href: 'stores.html', icon: HEADER_MENU_ICON.stores },
    { label: 'Categories', href: 'categories.html', icon: HEADER_MENU_ICON.categories }
  ];

  if (!hasStore) {
    items.push({
      label: 'Create Store',
      href: 'owner/login.html?tab=register',
      icon: HEADER_MENU_ICON.createStore
    });
  }

  items.push({
    label: 'Help & Support',
    href: HEADER_MENU_ENQUIRY,
    icon: HEADER_MENU_ICON.help,
    external: true
  });
  items.push({ label: 'Tips', href: 'customer-tips.html', icon: HEADER_MENU_ICON.tips });

  // Signed in as a customer: straight to the dashboard. Signed in only as a
  // seller: neither destination is the obvious one, so ask - the same chooser
  // the homepage "Sign In" link used to open. Signed in as neither: the
  // customer login, which is what "My Account" means to a shopper.
  if (hasCustomer) {
    items.push({
      label: 'My Account',
      href: 'customer-dashboard.html',
      icon: HEADER_MENU_ICON.account
    });
  } else if (hasStore) {
    items.push({
      label: 'My Account',
      href: 'customer-login.html',
      icon: HEADER_MENU_ICON.account,
      chooser: true
    });
  } else {
    items.push({
      label: 'My Account',
      href: 'customer-login.html',
      icon: HEADER_MENU_ICON.account
    });
  }

  if (recentCount > 0) {
    items.push({
      label: 'Recent Stores',
      href: 'stores.html#cart-stores',
      icon: HEADER_MENU_ICON.recent
    });
  }

  return items;
}

function initHeaderMenu() {
  const header = document.querySelector('header.site-header');
  if (!header || document.getElementById('header-menu-btn')) return;

  // Same host resolution as header-cart.js: the top row where a page has one,
  // otherwise the first container. stores.html has no .header-top-row.
  const host = header.querySelector('.header-top-row') || header.querySelector('.container');
  if (!host) return;

  const current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  const wrap = document.createElement('div');
  wrap.className = 'header-menu';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'header-menu-btn';
  btn.className = 'header-menu-btn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'header-menu-panel');
  btn.setAttribute('aria-label', 'Menu');
  btn.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="5" r="2"></circle>' +
    '<circle cx="12" cy="12" r="2"></circle>' +
    '<circle cx="12" cy="19" r="2"></circle></svg>';

  const panel = document.createElement('div');
  panel.id = 'header-menu-panel';
  panel.className = 'header-menu-panel';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Menu');
  panel.hidden = true;
  panel.innerHTML = headerMenuItems().map((it) => {
    // A mailto and the page you are already on are both links, but only one of
    // them is a destination. The current page keeps its entry (the menu reads
    // the same on every page) and says so instead of pretending otherwise.
    const isCurrent = !it.external && it.href.split('#')[0].toLowerCase() === current;
    return '<a class="header-menu-item' + (isCurrent ? ' is-current' : '') + '"' +
      ' role="menuitem" href="' + it.href + '"' +
      (isCurrent ? ' aria-current="page"' : '') +
      (it.chooser ? ' data-login-chooser="1"' : '') +
      '><span class="header-menu-icon">' + it.icon + '</span>' +
      '<span class="header-menu-label">' + escapeHtml(it.label) + '</span></a>';
  }).join('');

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  host.appendChild(wrap);

  wireHeaderMenu(btn, panel);
}

function headerMenuLinks(panel) {
  return Array.prototype.slice.call(panel.querySelectorAll('.header-menu-item'));
}

function closeHeaderMenu(btn, panel, refocus) {
  if (panel.hidden) return;
  panel.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

function openHeaderMenu(btn, panel, focusFirst) {
  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  if (focusFirst) {
    const links = headerMenuLinks(panel);
    if (links.length) links[0].focus();
  }
}

function wireHeaderMenu(btn, panel) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();          // or the document handler below shuts it again
    if (panel.hidden) openHeaderMenu(btn, panel, false);
    else closeHeaderMenu(btn, panel, false);
  });

  // Down-arrow on the button is the one keyboard gesture a menu button is
  // expected to answer beyond Enter/Space, and it should land ON the list.
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'Down') return;
    e.preventDefault();
    openHeaderMenu(btn, panel, true);
  });

  panel.addEventListener('keydown', (e) => {
    const links = headerMenuLinks(panel);
    const i = links.indexOf(document.activeElement);

    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      closeHeaderMenu(btn, panel, true);   // don't strand the keyboard user
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'Down') {
      e.preventDefault();
      if (links.length) links[(i + 1 + links.length) % links.length].focus();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'Up') {
      e.preventDefault();
      if (links.length) links[(i - 1 + links.length) % links.length].focus();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      if (links.length) links[0].focus();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      if (links.length) links[links.length - 1].focus();
    }
  });

  // Tabbing past the last item leaves the menu, so the menu should not still
  // be sitting open behind whatever the focus landed on. A click inside moves
  // focus out too, but that navigates, so the close is invisible either way.
  panel.addEventListener('focusout', () => {
    // Deferred one tick: at focusout time the new focus is not in the DOM's
    // activeElement yet, so asking now always says "left the panel".
    setTimeout(() => {
      if (!panel.contains(document.activeElement)) closeHeaderMenu(btn, panel, false);
    }, 0);
  });

  panel.addEventListener('click', (e) => {
    const link = e.target.closest('[data-login-chooser]');
    if (!link) return;
    e.preventDefault();
    closeHeaderMenu(btn, panel, false);
    showLoginChooser();
  });

  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    closeHeaderMenu(btn, panel, false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (panel.hidden) return;
    closeHeaderMenu(btn, panel, true);
  });
}

/**
 * Customer or seller? Asked only of someone who holds a seller token but no
 * customer one, where "My Account" has two honest answers and guessing sends
 * half of them to a login form for an account they do not have.
 *
 * Lifted out of home-nav.js, which this menu replaced.
 */
function showLoginChooser() {
  if (document.getElementById('login-chooser')) return;
  const overlay = document.createElement('div');
  overlay.id = 'login-chooser';
  overlay.className = 'login-chooser-overlay';
  overlay.innerHTML =
    '<div class="login-chooser-card" role="dialog" aria-modal="true" aria-label="Choose how to log in">' +
    '<h2>Log In</h2>' +
    '<a class="btn btn-primary btn-block" href="customer-login.html">Customer Login</a>' +
    '<a class="btn btn-block" href="owner/login.html">Seller Login</a>' +
    '<button type="button" class="btn btn-block login-chooser-cancel">Cancel</button>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('login-chooser-cancel')) overlay.remove();
  });
  document.addEventListener('keydown', function onEsc(ev) {
    if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  });
}
