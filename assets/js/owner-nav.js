// Shared logout + unread-messages badge wiring for every owner/*.html page.
document.addEventListener('DOMContentLoaded', () => {
  // The purple top bar stays on screen (owner.css). Its height - it wraps to
  // two lines on a narrow phone - goes in --owner-topbar-h so the other sticky
  // parts of a page (admin section menu, previews) sit just below it.
  const topbar = document.querySelector('.owner-topbar');
  if (topbar) {
    const publish = () => document.documentElement.style.setProperty('--owner-topbar-h', topbar.offsetHeight + 'px');
    publish();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publish).observe(topbar);
    else window.addEventListener('resize', publish);
  }

  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await Auth.logout();
      window.location.href = 'login.html';
    });
  }

  // One-shot on page load (not polled) - matches owner-dashboard.js's own
  // metrics, which also load once rather than staying live. messages.html
  // itself has the richer, actually-live polling for the active inbox.
  // Fetched only where it always was (the dashboard). The sidebar shows the
  // same count on other pages from this tab's memory - no extra request.
  const badge = document.getElementById('nav-messages-badge');
  const token = Auth.getToken();
  if (badge && token) {
    Api.post('getUnreadCount', { token }).then((res) => {
      if (res.ok && res.unreadCount > 0) {
        badge.textContent = res.unreadCount;
        badge.classList.remove('hidden');
      }
      if (res.ok) {
        try { sessionStorage.setItem('skiri_seller_unread', String(res.unreadCount || 0)); } catch (e) { /* private mode */ }
        if (typeof SellerShell !== 'undefined') SellerShell.setBadge('messages', res.unreadCount);
      }
    });
  }
});

/**
 * Seller dashboard shell (Oct 2026 dashboard modernisation): one sidebar for
 * every store-owner page, built here so each page does not repeat it.
 *  - Computer (>= 1024px): a fixed purple sidebar - the store-owner colour the
 *    top bar already uses - with icons and labels, collapsible to icons only.
 *  - Phone and tablet: a bottom tab bar (Dashboard, Orders, Products,
 *    Messages, More). "More" opens the full menu as a drawer.
 * Only links to pages that exist; Admin only for an admin session (the admin
 * page still checks on the server). The existing top bar stays as it is.
 */
const SellerShell = (() => {
  const ICON = {
    dashboard: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    products: '<path d="M20 7 12 3 4 7v10l8 4 8-4z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
    inventory: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
    orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    bookings: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    messages: '<path d="M4 5h16v11H8l-4 4z"/>',
    campaigns: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
    invoices: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h5"/>',
    feature: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    admin: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    collapse: '<path d="m15 6-6 6 6 6"/>',
    pos: '<rect x="4" y="3" width="16" height="7" rx="1"/><path d="M6 14h3M11 14h3M16 14h2M6 18h3M11 18h3M16 18h2"/>',
    integrations: '<path d="M9 7H6a3 3 0 0 0 0 6h3M15 7h3a3 3 0 0 1 0 6h-3M8 10h8"/><path d="M12 14v6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    contacts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    sms: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>'
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
  const ITEMS = [
    ['dashboard.html', 'Dashboard', 'dashboard'], ['products.html', 'Products', 'products'], ['inventory.html', 'Inventory', 'inventory'],
    ['orders.html', 'Orders', 'orders'], ['bookings.html', 'Bookings', 'bookings'], ['messages.html', 'Messages', 'messages'],
    ['feature.html', 'Feature products', 'feature'], ['campaigns.html', 'My Campaigns', 'campaigns'], ['invoices.html', 'Invoices', 'invoices'], ['settings.html', 'Settings', 'settings']
  ];
  const TABS = ['dashboard.html', 'orders.html', 'products.html', 'messages.html'];
  const COLLAPSE_KEY = 'skiri_seller_sidebar_collapsed';
  const TYPE_LABEL = { wholesaler: 'Wholesaler / Distributor', distributor: 'Wholesaler / Distributor', retailer: 'Retailer' };

  function current() {
    const file = location.pathname.split('/').pop() || 'dashboard.html';
    if (file === 'inventory-sync.html' || file === 'inventory-help.html') return 'inventory.html';
    return file;
  }

  function build() {
    const body = document.body;
    if (!body || !body.classList.contains('owner-shell') || document.querySelector('.seller-sidebar')) return;
    if (/(^|\/)(login|forgot-password)\.html$/.test(location.pathname)) return;
    if (typeof Auth === 'undefined' || !Auth.getToken()) return;
    const owner = Auth.getOwner() || {};
    const here = current();
    const items = ITEMS.slice();
    // POS / Integrations only when the feature is switched on for this deployment.
    if (owner.posHub) { items.splice(items.findIndex((it) => it[0] === 'inventory.html') + 1, 0, ['pos.html', 'Point of Sale', 'pos'], ['integrations.html', 'POS & Integrations', 'integrations']); }
    // Contacts / SMS only when CONTACTS_SMS is switched on (Contacts.gs).
    if (owner.contactsSms) { items.splice(items.findIndex((it) => it[0] === 'messages.html') + 1, 0, ['contacts.html', 'Contacts', 'contacts'], ['sms.html', 'SMS', 'sms']); }
    if (owner.isAdmin) items.push(['admin.html', 'Admin', 'admin']);
    const link = (it, cls) => `<a class="${cls}${it[0] === here ? ' is-active' : ''}" href="${it[0]}"${it[0] === here ? ' aria-current="page"' : ''}>
      ${svg(it[2])}<span class="${cls}-label">${it[1]}</span>${it[2] === 'messages' ? '<span class="seller-nav-badge" data-seller-badge="messages" hidden></span>' : ''}</a>`;

    const side = document.createElement('nav');
    side.className = 'seller-sidebar';
    side.id = 'seller-sidebar';
    side.setAttribute('aria-label', 'Store menu');
    side.innerHTML = `
      <div class="seller-sidebar-brand"><img src="../assets/img/favicon.svg" alt="" width="28" height="28"><span class="seller-sidebar-label">Mwakete <small>Seller</small></span>
        <button type="button" class="seller-sidebar-collapse" aria-controls="seller-sidebar" aria-expanded="true" aria-label="Collapse menu">${svg('collapse')}</button></div>
      <div class="seller-sidebar-links">${items.map((it) => link(it, 'seller-link')).join('')}</div>
      <a class="seller-sidebar-store" href="../store.html?store=${encodeURIComponent(owner.storeSlug || '')}" target="_blank" rel="noopener">
        <span class="seller-sidebar-label"><strong>${escapeHtml(owner.storeName || 'My store')}</strong><small>${escapeHtml(TYPE_LABEL[owner.storeType] || 'Store')} · view storefront</small></span></a>`;
    body.insertBefore(side, body.firstChild);

    const tabs = document.createElement('nav');
    tabs.className = 'seller-tabbar';
    tabs.setAttribute('aria-label', 'Store shortcuts');
    tabs.innerHTML = items.filter((it) => TABS.indexOf(it[0]) !== -1).map((it) => link(it, 'seller-tab')).join('') +
      `<button type="button" class="seller-tab seller-tab-more" aria-controls="seller-sidebar" aria-expanded="false">${svg('more')}<span class="seller-tab-label">More</span></button>`;
    body.appendChild(tabs);
    body.classList.add('has-seller-shell');

    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { /* private mode */ }
    setCollapsed(collapsed);
    side.querySelector('.seller-sidebar-collapse').addEventListener('click', () => {
      collapsed = !body.classList.contains('seller-collapsed');
      setCollapsed(collapsed);
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
    });

    const more = tabs.querySelector('.seller-tab-more');
    // ☰ left of the store name in the purple top bar (owner request, Oct
    // 2026): opens the same menu as More. Phones and tablets only - on a
    // wide screen the menu is always shown.
    const topRow = document.querySelector('.owner-topbar .container');
    let menuBtn = null;
    if (topRow) {
      menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'seller-menu-btn';
      menuBtn.setAttribute('aria-controls', 'seller-sidebar');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-label', 'Store menu');
      menuBtn.innerHTML = svg('menu');
      const title = topRow.firstElementChild;
      const lead = document.createElement('div');
      lead.className = 'seller-topbar-lead';
      topRow.insertBefore(lead, title);
      lead.appendChild(menuBtn);
      if (title) lead.appendChild(title);
    }
    let opener = more;
    const scrim = document.createElement('div');
    scrim.className = 'seller-scrim';
    scrim.hidden = true;
    body.appendChild(scrim);
    const setDrawer = (open) => {
      body.classList.toggle('seller-drawer-open', open);
      scrim.hidden = !open;
      [more, menuBtn].forEach((b) => { if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false'); });
      if (open) { const first = side.querySelector('.seller-link'); if (first) first.focus(); } else opener.focus();
    };
    more.addEventListener('click', () => { opener = more; setDrawer(!body.classList.contains('seller-drawer-open')); });
    if (menuBtn) menuBtn.addEventListener('click', () => { opener = menuBtn; setDrawer(!body.classList.contains('seller-drawer-open')); });
    scrim.addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && body.classList.contains('seller-drawer-open')) setDrawer(false); });
  }

  function setCollapsed(on) {
    document.body.classList.toggle('seller-collapsed', on);
    const btn = document.querySelector('.seller-sidebar-collapse');
    if (btn) { btn.setAttribute('aria-expanded', on ? 'false' : 'true'); btn.setAttribute('aria-label', on ? 'Expand menu' : 'Collapse menu'); }
  }

  function setBadge(name, count) {
    document.querySelectorAll(`[data-seller-badge="${name}"]`).forEach((b) => {
      b.hidden = !(count > 0);
      b.textContent = count > 99 ? '99+' : String(count || '');
      b.setAttribute('aria-label', `${count} unread`);
    });
  }

  return { build, setBadge };
})();

document.addEventListener('DOMContentLoaded', () => {
  SellerShell.build();
  let known = 0;
  try { known = Number(sessionStorage.getItem('skiri_seller_unread')) || 0; } catch (e) { /* private mode */ }
  if (known) SellerShell.setBadge('messages', known);
});
