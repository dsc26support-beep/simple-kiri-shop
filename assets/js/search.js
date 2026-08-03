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

  statusEl.textContent = 'Loading…';

  const res = await Api.get('searchProducts', { q, category });
  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not load results right now.';
    return;
  }

  if (res.products.length === 0) {
    statusEl.textContent = 'No products found. Try a different search or category.';
    listEl.innerHTML = '';
    return;
  }

  statusEl.textContent = `${res.products.length} product${res.products.length === 1 ? '' : 's'} found.`;
  listEl.innerHTML = res.products.map(renderSearchResultCard).join('');
}

function renderSearchResultCard(product) {
  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const prices = product.variants.map((v) => v.price);
  const priceText =
    prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
      ? `${formatMoney(Math.min(...prices))} – ${formatMoney(Math.max(...prices))}`
      : formatMoney(prices[0]);

  return `
    <article class="product-card search-result-card">
      ${media}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <p class="helper-text">Sold by ${escapeHtml(product.storeName)}</p>
        <strong>${priceText}</strong>
        <a class="btn btn-primary" href="store.html?store=${encodeURIComponent(product.storeSlug)}">View in Store</a>
      </div>
    </article>
  `;
}
