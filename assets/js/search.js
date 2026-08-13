document.addEventListener('DOMContentLoaded', init);

async function init() {
  renderCategoryButtons('category-buttons');

  const q = getQueryParam('q') || '';
  const category = getQueryParam('category') || '';

  document.getElementById('search-input').value = q;
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);

  await runSearch(q, category);
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}

async function runSearch(q, category) {
  const statusEl = document.getElementById('results-status');
  const headingEl = document.getElementById('results-heading');
  const listEl = document.getElementById('results-list');

  if (category) {
    const match = CATEGORIES.find((c) => c.id === category);
    headingEl.textContent = match ? match.label : 'Results';
  } else if (q) {
    headingEl.textContent = `Results for "${q}"`;
  } else {
    headingEl.textContent = 'All Products';
  }

  const stopLoading = startLoadingMessage(statusEl);

  const res = await Api.get('searchProducts', { q, category });
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  if (res.products.length === 0) {
    statusEl.textContent = 'No products found. Try a different search or category.';
    listEl.innerHTML = '';
    return;
  }

  statusEl.textContent = `${res.products.length} product${res.products.length === 1 ? '' : 's'} found.`;
  listEl.innerHTML = res.products.map((p) => renderBrowseProductCard(p, { linkLabel: 'View in Store', cardClass: 'search-result-card' })).join('');
  recordProductViewsOnce(res.products.map((p) => p.productId));
}
