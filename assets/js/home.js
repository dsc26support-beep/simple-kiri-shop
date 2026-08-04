document.addEventListener('DOMContentLoaded', init);

function init() {
  renderCategoryButtons('category-buttons');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  loadTrendingProducts();
  loadTrendingStores();
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}

async function loadTrendingProducts() {
  const statusEl = document.getElementById('trending-products-status');
  const listEl = document.getElementById('trending-products-list');

  const res = await Api.get('listTopProducts', {});
  if (!res.ok) {
    statusEl.textContent = res.error || '';
    return;
  }
  if (res.products.length === 0) {
    statusEl.textContent = 'No products yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = res.products
    .map((p) => renderBrowseProductCard(p, { linkLabel: 'View', cardClass: 'trending-product-card' }))
    .join('');
  recordProductViewsOnce(res.products.map((p) => p.productId));
}

async function loadTrendingStores() {
  const statusEl = document.getElementById('trending-stores-status');
  const listEl = document.getElementById('trending-stores-list');

  const res = await Api.get('listTopStores', {});
  if (!res.ok) {
    statusEl.textContent = res.error || '';
    return;
  }
  if (res.stores.length === 0) {
    statusEl.textContent = 'No stores yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = res.stores.map(renderLogoCarouselItem).join('');
}
