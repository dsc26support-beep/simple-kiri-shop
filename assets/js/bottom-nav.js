// Mobile bottom navigation (§7). Injected on customer-facing pages; shown only
// on mobile via CSS. Five equal tabs: Home | Tips | Messages | Cart | Account.
document.addEventListener('DOMContentLoaded', initBottomNav);

const BOTTOM_NAV_ICON = {
  home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"></path></svg>',
  tips: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.2 1 2.5h6c0-1.3.4-1.9 1-2.5A6 6 0 0 0 12 3z"></path></svg>',
  messages: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>',
  cart: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>',
  account: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>'
};

function initBottomNav() {
  const current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const accountHref = (typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken())
    ? 'customer-dashboard.html' : 'customer-login.html';

  const items = [
    { label: 'Home', href: 'index.html', match: ['index.html', ''], icon: BOTTOM_NAV_ICON.home },
    { label: 'Tips', href: 'customer-tips.html', match: ['customer-tips.html'], icon: BOTTOM_NAV_ICON.tips },
    { label: 'Messages', href: 'customer-messages.html', match: ['customer-messages.html'], icon: BOTTOM_NAV_ICON.messages, badge: 'messages' },
    { label: 'Cart', href: 'cart.html', match: ['cart.html'], icon: BOTTOM_NAV_ICON.cart, badge: 'cart' },
    { label: 'Account', href: accountHref, match: ['customer-dashboard.html', 'customer-login.html'], icon: BOTTOM_NAV_ICON.account }
  ];

  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Primary');
  nav.innerHTML = items.map((it) => {
    const active = it.match.indexOf(current) !== -1;
    const badge = it.badge ? `<span class="bottom-nav-badge" data-badge="${it.badge}" hidden></span>` : '';
    return `<a class="bottom-nav-item${active ? ' is-active' : ''}" href="${it.href}"${active ? ' aria-current="page"' : ''}>
      <span class="bottom-nav-icon">${it.icon}${badge}</span>
      <span class="bottom-nav-label">${it.label}</span>
    </a>`;
  }).join('');

  document.body.appendChild(nav);
  document.body.classList.add('has-bottom-nav');

  updateBottomNavCartBadge();
  updateBottomNavMessagesBadge();
}

// Total items across every per-store cart (local; no API).
function updateBottomNavCartBadge() {
  const badge = document.querySelector('.bottom-nav-badge[data-badge="cart"]');
  if (!badge) return;
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('skiri_cart_') === 0) {
        try {
          (JSON.parse(localStorage.getItem(k)) || []).forEach((l) => { total += Number(l.qty) || 0; });
        } catch (e) { /* skip malformed cart */ }
      }
    }
  } catch (e) { /* storage unavailable */ }
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// Best-effort unread dot: only calls the backend if this device has chatted.
async function updateBottomNavMessagesBadge() {
  const badge = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
  if (!badge) return;
  const stores = [];
  const prefix = 'skiri_chat_token_';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) {
        const slug = k.slice(prefix.length);
        const token = localStorage.getItem(k);
        if (slug && token) stores.push({ storeSlug: slug, customerToken: token });
      }
    }
  } catch (e) { return; }
  if (stores.length === 0) return;

  const res = await Api.post('getCustomerInbox', { stores });
  if (!res.ok) return;
  const anyUnread = (res.conversations || []).some((c) => {
    if (c.lastSenderType !== 'vendor') return false;
    let seen = 0;
    try {
      const raw = localStorage.getItem('skiri_inbox_seen_' + c.storeSlug);
      seen = raw ? new Date(raw).getTime() : 0;
    } catch (e) { seen = 0; }
    const at = new Date(c.lastMessageAt).getTime();
    return !!at && at > seen;
  });
  if (anyUnread) {
    badge.classList.add('is-dot');
    badge.textContent = '';
    badge.hidden = false;
  }
}
