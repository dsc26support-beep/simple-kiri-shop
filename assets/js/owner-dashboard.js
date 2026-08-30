document.addEventListener('DOMContentLoaded', init);

// Products/Orders/Bookings/Messages quick links: plain navigations to other
// owner pages. Deliberately NO loading animation - these are page loads with
// nothing real to wait on, and the old fake spinner had no stop condition:
// it set btn.disabled + an infinite dots animation and never cleared it, so a
// bfcache Back restored the frozen, still-"loading" button (the reported
// "spinner never stops" bug). Navigate straight away instead.
function wireQuickLinks() {
  document.querySelectorAll('.dashboard-quick-links .btn').forEach((btn) => {
    const href = btn.dataset.href;
    if (!href) return;
    btn.addEventListener('click', () => {
      window.location.href = href;
    });
  });
}

// Safety net for bfcache restores (Back button): if a quick-link button was
// ever left disabled, re-enable it so it can't come back stuck.
window.addEventListener('pageshow', () => {
  document.querySelectorAll('.dashboard-quick-links .btn[disabled]').forEach((btn) => {
    btn.disabled = false;
  });
});

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;
  document.getElementById('welcome-name').textContent = `, ${owner.storeName}`;
  document.getElementById('storefront-link').href = `../store.html?store=${encodeURIComponent(owner.storeSlug)}`;

  wireQuickLinks();

  renderStoreToggle(owner.status);
  document.getElementById('store-status-toggle').addEventListener('click', onToggleStoreStatus);

  // limit:100 so the pending counts below (and the totals) reflect the whole
  // store, not just the first default page. The Messages badge is populated
  // separately by owner-nav.js (getUnreadCount).
  const [productsRes, ordersRes, bookingsRes] = await Promise.all([
    Api.post('listOwnerProducts', { token: Auth.getToken() }),
    Api.post('listOwnerOrders', { token: Auth.getToken(), limit: 100 }),
    Api.post('listOwnerBookings', { token: Auth.getToken(), limit: 100 })
  ]);

  if (productsRes.ok) {
    const activeCount = productsRes.products.filter((p) => p.status === 'active').length;
    document.getElementById('metric-products').textContent = activeCount;
  }

  if (ordersRes.ok) {
    document.getElementById('metric-orders').textContent = ordersRes.total != null ? ordersRes.total : ordersRes.orders.length;
    const pending = ordersRes.orders.filter((o) => o.status === 'Pending Payment').length;
    document.getElementById('metric-pending').textContent = pending;
    setNavBadge('nav-orders-badge', pending);
  }

  if (bookingsRes.ok) {
    const pendingBookings = bookingsRes.bookings.filter((b) => b.status === 'Pending').length;
    setNavBadge('nav-bookings-badge', pendingBookings);
  }
}

// Open/Closed store toggle. OPEN = 'active' (visible to customers),
// CLOSED = 'standby' (hidden from customers, but the seller stays logged in
// and keeps full access - deliberately NOT 'closed', which locks the account
// out; that hard delete lives in Settings). Reuses the existing setStoreStatus
// endpoint - no backend change. Anything other than standby/closed is treated
// as open, so an older session profile without a status still reads correctly.
function renderStoreToggle(status) {
  const toggle = document.getElementById('store-status-toggle');
  if (!toggle) return;
  const open = status !== 'standby' && status !== 'closed';
  toggle.setAttribute('aria-checked', open ? 'true' : 'false');
  toggle.classList.toggle('is-open', open);
  document.getElementById('store-status-open-label').classList.toggle('active', open);
  document.getElementById('store-status-closed-label').classList.toggle('active', !open);
  document.getElementById('store-status-toggle-hint').textContent = open
    ? 'Your store is OPEN — visible to customers.'
    : 'Your store is CLOSED — hidden from customers. You stay logged in.';
}

async function onToggleStoreStatus() {
  const toggle = document.getElementById('store-status-toggle');
  const hint = document.getElementById('store-status-toggle-hint');
  const owner = Auth.getOwner();
  const next = owner.status === 'standby' ? 'active' : 'standby';

  toggle.disabled = true;
  const res = await Api.post('setStoreStatus', { token: Auth.getToken(), status: next });
  toggle.disabled = false;

  if (!res.ok) {
    hint.textContent = res.error || 'Could not update store status. Please try again.';
    return;
  }
  owner.status = next;
  Auth.saveSession(Auth.getToken(), owner);
  renderStoreToggle(next);
}

// Shows a red count in a quick-link button's corner when there's something
// needing attention; hides it at zero. Caps the display at 99+ so a big backlog
// never blows out the pill.
function setNavBadge(id, count) {
  const badge = document.getElementById(id);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}
