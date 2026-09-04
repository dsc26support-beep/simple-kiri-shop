document.addEventListener('DOMContentLoaded', init);

function init() {
  renderCategoryButtons('category-buttons');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  loadHomePageData();
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}

// One combined request for both sections below, instead of two separate
// round trips - Apps Script's own per-request execution-startup overhead
// is the dominant cost for a page load like this, so halving the number of
// round trips is what actually moves the needle on "page feels slow," not
// anything about the Sheets reads themselves (both halves are still served
// from the same 300s caches actionListTopProducts/actionListTopStores use).
async function loadHomePageData() {
  const productsStatusEl = document.getElementById('trending-products-status');
  const storesStatusEl = document.getElementById('trending-stores-status');
  const stopProductsLoading = startLoadingMessage(productsStatusEl);
  const stopStoresLoading = startLoadingMessage(storesStatusEl);

  const request = Api.get('getHomePageData', {});
  // The request this page paints from; whenIdle() waits for it (helpers.js).
  window.__criticalReady = request;
  const res = await request;
  stopProductsLoading();
  stopStoresLoading();
  if (!res.ok) {
    showLoadFailedMessage(productsStatusEl);
    showLoadFailedMessage(storesStatusEl);
    return;
  }
  renderTrendingProducts(res.products);
  renderTrendingStores(res.stores);
}

function renderTrendingProducts(products) {
  const statusEl = document.getElementById('trending-products-status');
  const listEl = document.getElementById('trending-products-list');

  if (products.length === 0) {
    statusEl.textContent = 'No products yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = products.map((p) => renderBrowseProductCard(p)).join('');
  fitPriceLabels(listEl);
  recordProductViewsOnce(products.map((p) => p.productId));
}

function renderTrendingStores(stores) {
  const statusEl = document.getElementById('trending-stores-status');
  const listEl = document.getElementById('trending-stores-list');

  if (stores.length === 0) {
    statusEl.textContent = 'No stores yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = stores.map(renderLogoCarouselItem).join('');
}
