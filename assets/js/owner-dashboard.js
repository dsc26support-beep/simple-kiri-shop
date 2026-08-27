document.addEventListener('DOMContentLoaded', init);

// Products/Orders/Bookings/Messages moved here from the top nav - a brief
// "loading" pulse before navigating, purely so the click feels acknowledged
// (these are plain page loads, not API calls, so there's nothing real to
// wait on).
const QUICK_LINK_DELAY_MS = 500;

function wireQuickLinks() {
  document.querySelectorAll('.dashboard-quick-links .btn').forEach((btn) => {
    const label = btn.dataset.label;
    const href = btn.dataset.href;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.innerHTML = `${escapeHtml(label)}<span class="btn-saving-dots"><span></span><span></span><span></span></span>`;
      setTimeout(() => {
        window.location.href = href;
      }, QUICK_LINK_DELAY_MS);
    });
  });
}

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;
  document.getElementById('welcome-name').textContent = `, ${owner.storeName}`;
  document.getElementById('storefront-link').href = `../store.html?store=${encodeURIComponent(owner.storeSlug)}`;

  wireQuickLinks();

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
