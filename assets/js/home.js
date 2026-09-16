document.addEventListener('DOMContentLoaded', init);

function init() {
  // Both strips come from the shared taxonomy and need no backend at all, so
  // they are on screen with the first paint rather than after a round trip.
  renderCategoryStrip('category-strip');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  startSearchPrompts();
  loadHomePageData();
}

/**
 * Three prompts in the home search box, one at a time.
 *
 * Home only. The other three search boxes say what they actually search
 * ("Search this category…"), which tells a shopper more than a general
 * question would.
 *
 * Three rules this follows, none of them optional:
 *
 * 1. THE ACCESSIBLE NAME DOES NOT ROTATE. A placeholder is part of what a
 *    screen reader announces for a field, so a rotating one is a field that
 *    renames itself every few seconds while someone is still deciding what to
 *    type. An aria-label is set once and stays; the rotation is then purely
 *    visual and reaches nobody who is listening.
 *
 * 2. IT STOPS THE MOMENT THEY ENGAGE. A prompt that changes while a shopper is
 *    reading it is the prompt moving out from under them.
 *
 * 3. REDUCED MOTION GETS ONE PROMPT AND NO TIMER. Text that changes on its own
 *    is motion, whatever else it is.
 *
 * Nothing here can shift the layout: the input's width comes from the flex row,
 * not from its text, so the box is the same size whichever prompt is showing.
 */
const SEARCH_PROMPTS = [
  'What is on your mind?',
  'Ask Mwakete…',
  'Try using Kiribati language.'
];

const SEARCH_PROMPT_MS = 3500;

function startSearchPrompts() {
  const input = document.getElementById('search-input');
  if (!input) return;

  input.setAttribute('aria-label', 'Search products, services and rentals');
  input.placeholder = SEARCH_PROMPTS[0];

  const reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % SEARCH_PROMPTS.length;
    input.placeholder = SEARCH_PROMPTS[i];
  }, SEARCH_PROMPT_MS);

  const stop = () => clearInterval(timer);
  input.addEventListener('focus', stop, { once: true });
  input.addEventListener('input', stop, { once: true });
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `categories.html?q=${encodeURIComponent(q)}`;
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
  listEl.innerHTML = products.map((p) => renderBrowseProductCard(p, { showLocation: true })).join('');
  // Card badges cannot carry their own popover (they are inside the card's
  // link), so the page explains them once. Renders nothing when no card on the
  // page has a badge - which on a young marketplace is most pages.
  mountBadgeLegend('home-badge-legend', products);
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
