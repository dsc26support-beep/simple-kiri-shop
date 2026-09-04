// Cross-store search results.
//
// The backend returns one flat, already-filtered list per query (see
// actionSearchProducts) and caches it for 60s. Sorting, filtering and paging
// therefore all happen HERE, over that single response: a Google Sheet is not
// a query engine, and every extra facet pushed server-side would mean another
// full scan of Owners + Variants + Products. One request, many views of it.
//
// Every control writes itself into the URL, so the browser's Back button
// restores the exact search state - term, category, sort, filters and how many
// results were showing - instead of dumping the customer back at page one.

const PAGE_SIZE = 24;

// Only offer a facet the data can actually support. "Highest rated" is backed
// by real customer reviews (Reviews.gs computes the aggregate server-side).
// There is still no delivery-time or discount data, so there is deliberately
// no "Fastest delivery" or "Biggest discount" sort - inventing one would be a
// ranking the marketplace cannot honestly justify.
const SORTS = {
  relevance: null, // server order, refined by relevanceScore when there's a query
  cheapest: (a, b) => minPrice(a) - minPrice(b),
  dearest: (a, b) => minPrice(b) - minPrice(a),
  popular: (a, b) => (Number(b.views) || 0) - (Number(a.views) || 0),
  // Unrated products sort last rather than ahead of a genuine 1-star.
  rated: (a, b) => (Number(b.rating) || -1) - (Number(a.rating) || -1),
  newest: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''))
};

const DELIVERY_FILTERS = [
  { key: 'truck', label: 'Truck', field: 'storeDeliveryTruck' },
  { key: 'ship', label: 'Boat / Ship', field: 'storeDeliveryShip' },
  { key: 'airCargo', label: 'Air Cargo', field: 'storeDeliveryAirCargo' },
  { key: 'pickPay', label: 'Pick & Pay', field: 'storeDeliveryPickPay' }
];

let allProducts = [];
let shownCount = PAGE_SIZE;
let currentQuery = '';
let currentCategory = '';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  renderCategoryButtons('category-buttons');

  currentQuery = getQueryParam('q') || '';
  currentCategory = getQueryParam('category') || '';

  document.getElementById('search-input').value = currentQuery;
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);

  wireControls();
  await runSearch(currentQuery, currentCategory);
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  // A new search term starts a fresh result set, so stale sort/filter state
  // from the previous search is deliberately not carried over.
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}

/* ---------- URL state (§32) ---------- */

// Filters and sort live in the query string rather than in memory, so opening
// a product and pressing Back returns to the same results, scrolled to the
// same depth, instead of resetting to the first page of an unsorted list.
function readState() {
  const num = (v) => (v === null || v === '' ? null : Number(v));
  return {
    sort: getQueryParam('sort') || 'relevance',
    maxPrice: num(getQueryParam('maxPrice')),
    store: getQueryParam('store') || '',
    delivery: (getQueryParam('delivery') || '').split(',').filter(Boolean),
    availableOnly: getQueryParam('avail') === '1',
    shown: num(getQueryParam('shown')) || PAGE_SIZE
  };
}

function writeState(state, { replace = true } = {}) {
  const url = new URL(window.location.href);
  const p = url.searchParams;
  const set = (k, v) => (v === null || v === '' || v === false ? p.delete(k) : p.set(k, String(v)));

  set('sort', state.sort === 'relevance' ? '' : state.sort);
  set('maxPrice', state.maxPrice === null ? '' : state.maxPrice);
  set('store', state.store);
  set('delivery', state.delivery.join(','));
  set('avail', state.availableOnly ? '1' : '');
  set('shown', state.shown > PAGE_SIZE ? state.shown : '');

  // replaceState while adjusting controls (so Back leaves the results page
  // rather than stepping through every filter tweak); pushState only for
  // Load More, which is the one action worth being able to undo.
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method](null, '', url.toString());
}

/* ---------- helpers over the result shape ---------- */

function minPrice(p) {
  const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => !isNaN(n));
  return prices.length ? Math.min(...prices) : Infinity;
}

// "Relevance" with a query means: a hit in the product name beats a hit only in
// the description, and an exact word beats a partial one. Without a query there
// is nothing to score against, so the server's order stands.
function relevanceScore(p, q) {
  const name = String(p.name || '').toLowerCase();
  const desc = String(p.description || '').toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.indexOf(q) !== -1) return 2;
  if (desc.indexOf(q) !== -1) return 3;
  return 4;
}

/* ---------- filtering + sorting ---------- */

function applyState(products, state) {
  let out = products.slice();

  if (state.maxPrice !== null) out = out.filter((p) => minPrice(p) <= state.maxPrice);
  if (state.store) out = out.filter((p) => p.storeSlug === state.store);
  if (state.availableOnly) out = out.filter((p) => p.available !== false);
  if (state.delivery.length) {
    out = out.filter((p) =>
      state.delivery.some((key) => {
        const f = DELIVERY_FILTERS.find((d) => d.key === key);
        return f && p[f.field] === true;
      })
    );
  }

  const cmp = SORTS[state.sort];
  if (cmp) {
    out.sort(cmp);
  } else if (currentQuery) {
    const q = currentQuery.toLowerCase();
    out.sort((a, b) => relevanceScore(a, q) - relevanceScore(b, q));
  }
  return out;
}

function activeFilterCount(state) {
  return (
    (state.maxPrice !== null ? 1 : 0) +
    (state.store ? 1 : 0) +
    (state.availableOnly ? 1 : 0) +
    state.delivery.length
  );
}

/* ---------- controls ---------- */

function wireControls() {
  const panel = document.getElementById('filters-panel');
  const toggle = document.getElementById('filters-toggle');

  toggle.addEventListener('click', () => {
    const open = !panel.hidden;
    panel.hidden = open;
    toggle.setAttribute('aria-expanded', String(!open));
  });
  document.getElementById('filters-done').addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });

  document.getElementById('results-sort').addEventListener('change', (e) => {
    const state = readState();
    state.sort = e.target.value;
    state.shown = PAGE_SIZE;
    writeState(state);
    render();
  });

  const priceInput = document.getElementById('filter-price-max');
  const onPrice = () => {
    const state = readState();
    // At the top of the range the filter is off entirely, so the URL stays
    // clean and "no maximum" is distinguishable from "maximum happens to be
    // the most expensive product".
    state.maxPrice = Number(priceInput.value) >= Number(priceInput.max) ? null : Number(priceInput.value);
    state.shown = PAGE_SIZE;
    writeState(state);
    render();
  };
  priceInput.addEventListener('input', updatePriceOutput);
  priceInput.addEventListener('change', onPrice);

  document.getElementById('filter-store').addEventListener('change', (e) => {
    const state = readState();
    state.store = e.target.value;
    state.shown = PAGE_SIZE;
    writeState(state);
    render();
  });

  document.getElementById('filter-available').addEventListener('change', (e) => {
    const state = readState();
    state.availableOnly = e.target.checked;
    state.shown = PAGE_SIZE;
    writeState(state);
    render();
  });

  document.getElementById('filters-clear').addEventListener('click', clearFilters);

  document.getElementById('load-more-btn').addEventListener('click', () => {
    const state = readState();
    state.shown = state.shown + PAGE_SIZE;
    writeState(state, { replace: false });
    shownCount = state.shown;
    render();
  });

  // Back/forward between Load More steps re-renders rather than reloading.
  window.addEventListener('popstate', () => {
    syncControlsFromState(readState());
    render();
  });
}

function clearFilters() {
  const state = readState();
  state.maxPrice = null;
  state.store = '';
  state.delivery = [];
  state.availableOnly = false;
  state.shown = PAGE_SIZE;
  writeState(state);
  syncControlsFromState(state);
  render();
}

function updatePriceOutput() {
  const input = document.getElementById('filter-price-max');
  const out = document.getElementById('filter-price-out');
  out.textContent =
    Number(input.value) >= Number(input.max) ? 'Any price' : `Up to ${formatMoney(Number(input.value))}`;
}

// Build only the facets this result set can actually support: the delivery
// chips list methods some store here offers, the seller list holds sellers
// present in these results, and availability only appears for booking
// listings. A facet that filters nothing is noise.
function buildFilters(products) {
  const deliveryEl = document.getElementById('filter-delivery');
  const available = DELIVERY_FILTERS.filter((d) => products.some((p) => p[d.field] === true));
  document.getElementById('filter-delivery-row').hidden = available.length === 0;
  deliveryEl.innerHTML = available
    .map(
      (d) =>
        `<label class="filter-chip"><input type="checkbox" value="${d.key}" data-delivery> <span>${escapeHtml(d.label)}</span></label>`
    )
    .join('');
  deliveryEl.querySelectorAll('[data-delivery]').forEach((el) => {
    el.addEventListener('change', () => {
      const state = readState();
      state.delivery = [...deliveryEl.querySelectorAll('[data-delivery]:checked')].map((c) => c.value);
      state.shown = PAGE_SIZE;
      writeState(state);
      render();
    });
  });

  const storeSel = document.getElementById('filter-store');
  const stores = [...new Map(products.map((p) => [p.storeSlug, p.storeName])).entries()].sort((a, b) =>
    String(a[1]).localeCompare(String(b[1]))
  );
  storeSel.innerHTML =
    '<option value="">All sellers</option>' +
    stores.map(([slug, name]) => `<option value="${escapeHtml(slug)}">${escapeHtml(name)}</option>`).join('');
  document.getElementById('filter-store-row').hidden = stores.length < 2;

  const prices = products.map(minPrice).filter((n) => isFinite(n));
  const priceRow = document.getElementById('filter-price-row');
  const priceInput = document.getElementById('filter-price-max');
  if (prices.length === 0) {
    priceRow.hidden = true;
  } else {
    priceRow.hidden = false;
    priceInput.min = '0';
    priceInput.max = String(Math.ceil(Math.max(...prices)));
    // Always step by 1. A coarser step silently snaps any value restored from
    // the URL to the nearest valid stop, so ?maxPrice=50 would come back as 48
    // and the filter would no longer match the link that was shared.
    priceInput.step = '1';
  }

  document.getElementById('filter-available-row').hidden = !products.some((p) => typeof p.available === 'boolean');
}

function syncControlsFromState(state) {
  document.getElementById('results-sort').value = state.sort;
  const priceInput = document.getElementById('filter-price-max');
  priceInput.value = state.maxPrice === null ? priceInput.max : String(state.maxPrice);
  updatePriceOutput();
  document.getElementById('filter-store').value = state.store;
  document.getElementById('filter-available').checked = state.availableOnly;
  document
    .getElementById('filter-delivery')
    .querySelectorAll('[data-delivery]')
    .forEach((el) => {
      el.checked = state.delivery.indexOf(el.value) !== -1;
    });
  shownCount = state.shown;
  updateFilterBadge(state);
}

// Kept out of syncControlsFromState so it can also run on every render: each
// filter handler writes state and re-renders without a full control sync, and
// a stale badge is exactly what makes a filtered-empty page look like an empty
// marketplace.
function updateFilterBadge(state) {
  const count = activeFilterCount(state);
  const badge = document.getElementById('filters-count');
  badge.textContent = count ? String(count) : '';
  badge.hidden = count === 0;
}

/* ---------- rendering ---------- */

function render() {
  const statusEl = document.getElementById('results-status');
  const listEl = document.getElementById('results-list');
  const moreEl = document.getElementById('results-more');
  const state = readState();

  const filtered = applyState(allProducts, state);
  updateFilterBadge(state);

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    moreEl.hidden = true;
    renderNoResults(statusEl, state);
    return;
  }

  const page = filtered.slice(0, Math.max(PAGE_SIZE, shownCount));
  const noun = `product${filtered.length === 1 ? '' : 's'}`;
  if (page.length < filtered.length) {
    statusEl.textContent = `Showing ${page.length} of ${filtered.length} ${noun}.`;
  } else if (filtered.length === allProducts.length) {
    statusEl.textContent = `${filtered.length} ${noun} found.`;
  } else {
    statusEl.textContent = `${filtered.length} matching ${noun}.`;
  }

  listEl.innerHTML = page.map((p) => renderBrowseProductCard(p, { cardClass: 'search-result-card', showLocation: true })).join('');
  moreEl.hidden = page.length >= filtered.length;
  recordProductViewsOnce(page.map((p) => p.productId));
}

// "No products found." is a dead end. Distinguish the two very different
// reasons a customer sees nothing, and give each one an actual way forward.
function renderNoResults(statusEl, state) {
  const filtersActive = activeFilterCount(state) > 0;

  if (filtersActive && allProducts.length > 0) {
    statusEl.innerHTML =
      `No products match your filters. <button type="button" class="link-button" id="no-results-clear">Clear filters</button> ` +
      `to see all ${allProducts.length} result${allProducts.length === 1 ? '' : 's'}.`;
    document.getElementById('no-results-clear').addEventListener('click', clearFilters);
    return;
  }

  const what = currentQuery ? `"${escapeHtml(currentQuery)}"` : 'that';
  statusEl.innerHTML =
    `<strong>No exact match for ${what}.</strong><br>` +
    'Try a shorter or more general word, browse a category above, or ' +
    '<a href="search.html">see all products</a>.';
}

/* ---------- load ---------- */

async function runSearch(q, category) {
  const statusEl = document.getElementById('results-status');
  const headingEl = document.getElementById('results-heading');

  if (category) {
    const match = CATEGORIES.find((c) => c.id === category);
    headingEl.textContent = match ? match.label : 'Results';
  } else if (q) {
    headingEl.textContent = `Results for "${q}"`;
  } else {
    headingEl.textContent = 'All Products';
  }

  const stopLoading = startLoadingMessage(statusEl);
  const request = Api.get('searchProducts', { q, category });
  // The request this page paints from; whenIdle() waits for it (helpers.js).
  window.__criticalReady = request;
  const res = await request;
  stopLoading();

  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  allProducts = res.products || [];

  // The toolbar is meaningless with nothing to sort or filter, so it only
  // appears once there is a result set behind it.
  document.getElementById('results-toolbar').hidden = allProducts.length === 0;

  buildFilters(allProducts);
  syncControlsFromState(readState());
  render();
}
