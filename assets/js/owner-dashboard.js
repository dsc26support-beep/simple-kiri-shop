document.addEventListener('DOMContentLoaded', init);

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;
  document.getElementById('welcome-name').textContent = `, ${owner.storeName}`;
  document.getElementById('storefront-link').href = `../store.html?store=${encodeURIComponent(owner.storeSlug)}`;

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
