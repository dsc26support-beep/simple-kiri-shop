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

  const [productsRes, ordersRes] = await Promise.all([
    Api.post('listOwnerProducts', { token: Auth.getToken() }),
    Api.post('listOwnerOrders', { token: Auth.getToken() })
  ]);

  if (productsRes.ok) {
    const activeCount = productsRes.products.filter((p) => p.status === 'active').length;
    document.getElementById('metric-products').textContent = activeCount;
  }

  if (ordersRes.ok) {
    document.getElementById('metric-orders').textContent = ordersRes.orders.length;
    const pending = ordersRes.orders.filter((o) => o.status === 'Pending Payment').length;
    document.getElementById('metric-pending').textContent = pending;
  }
}
