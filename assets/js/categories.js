// Browse-by-category page: a rail of categories on the left, that category's
// products on the right, swapped in place rather than by navigating.
//
// There is no second level to show. CATEGORIES (helpers.js) is six flat
// entries and products carry a single Category, so the right-hand pane holds
// products rather than subcategories.
//
// No backend work was needed: actionSearchProducts already answers a
// category-only query (an empty q skips its text filter), and it returns the
// whole match set, so paging is client-side - the same PAGE_SIZE/shownCount
// shape search.js uses, rather than a second idiom for the same job.
document.addEventListener('DOMContentLoaded', init);

const CATEGORY_PAGE_SIZE = 12;

let currentCategory = '';
let categoryProducts = [];
let shownCount = CATEGORY_PAGE_SIZE;
// Results are cached per category for the life of the page, so flicking back
// and forth along the rail doesn't re-hit a backend that takes a second to
// answer on a mobile connection.
const categoryCache = {};

async function init() {
  renderRail();
  document.getElementById('category-more').addEventListener('click', onShowMore);

  const requested = getQueryParam('category');
  // An unknown slug (a stale link, a renamed category) falls back to the first
  // rather than rendering an empty page with nothing selected.
  const known = CATEGORIES.some((c) => c.id === requested);
  await selectCategory(known ? requested : CATEGORIES[0].id, { replaceUrl: false });
}

/**
 * Text only, no colour chip.
 *
 * The chip reused .placeholder-swatch for its colour, and that class - defined
 * later in the stylesheet at equal specificity - sets width:100%, so every chip
 * inflated to fill the rail and pushed the labels out across the product grid.
 * Text alone matches the reference, gives the labels the full rail width, and
 * removes the collision rather than working around it.
 */
function renderRail() {
  document.getElementById('category-rail').innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="category-rail-item" data-category="${escapeHtml(c.id)}" aria-pressed="false">
      <span class="category-rail-label">${escapeHtml(c.label)}</span>
    </button>
  `).join('');

  document.getElementById('category-rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.category-rail-item');
    if (btn) selectCategory(btn.dataset.category);
  });
}

function markSelected(categoryId) {
  document.querySelectorAll('.category-rail-item').forEach((btn) => {
    const on = btn.dataset.category === categoryId;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

async function selectCategory(categoryId, opts) {
  if (categoryId === currentCategory) return;
  currentCategory = categoryId;
  shownCount = CATEGORY_PAGE_SIZE;
  markSelected(categoryId);

  const meta = CATEGORIES.find((c) => c.id === categoryId);
  document.getElementById('category-pane-heading').textContent = meta ? meta.label : 'Browse';
  document.title = `${meta ? meta.label : 'Browse'} — Mwakete`;

  // Keep the URL honest so a refresh, a back button or a shared link all land
  // on the category the shopper is actually looking at. replaceState, not
  // pushState: the rail is a filter, not a place, and stacking history entries
  // would make Back walk through every category they tried.
  if (!opts || opts.replaceUrl !== false) {
    const url = `${location.pathname}?category=${encodeURIComponent(categoryId)}`;
    history.replaceState(null, '', url);
  }

  if (categoryCache[categoryId]) {
    categoryProducts = categoryCache[categoryId];
    render();
    return;
  }

  const statusEl = document.getElementById('category-status');
  const listEl = document.getElementById('category-list');
  listEl.innerHTML = '';
  document.getElementById('category-more').hidden = true;
  const stopLoading = startLoadingMessage(statusEl);

  const request = Api.get('searchProducts', { category: categoryId });
  // The request this page paints from; whenIdle() waits for it (helpers.js).
  window.__criticalReady = request;
  const res = await request;
  stopLoading();

  // A slow tap on another category while this was in flight wins - drop the
  // stale response rather than painting it over what the shopper asked for.
  if (currentCategory !== categoryId) return;

  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  categoryProducts = res.products || [];
  categoryCache[categoryId] = categoryProducts;
  render();
}

function render() {
  const statusEl = document.getElementById('category-status');
  const listEl = document.getElementById('category-list');
  const moreEl = document.getElementById('category-more');

  if (categoryProducts.length === 0) {
    listEl.innerHTML = '';
    moreEl.hidden = true;
    statusEl.textContent = 'Nothing in this category yet — try another, or search for what you need.';
    return;
  }

  const page = categoryProducts.slice(0, Math.max(CATEGORY_PAGE_SIZE, shownCount));
  const noun = `product${categoryProducts.length === 1 ? '' : 's'}`;
  statusEl.textContent = page.length < categoryProducts.length
    ? `Showing ${page.length} of ${categoryProducts.length} ${noun}.`
    : `${categoryProducts.length} ${noun}.`;

  listEl.innerHTML = page.map(renderCategoryTile).join('');
  moreEl.hidden = page.length >= categoryProducts.length;
  recordProductViewsOnce(page.map((p) => p.productId));
}

/**
 * A browse tile: photo and name, nothing else.
 *
 * Deliberately NOT renderBrowseProductCard, which also carries the price
 * range, star rating, store name, phone number and delivery icons. That is the
 * right card for search results, where the shopper is comparing; here it made
 * the page unreadable. Price, store and delivery are all one tap away on the
 * product page.
 *
 * Same link target as every other product card, so the tap does what a shopper
 * expects from anywhere else on the site.
 */
function renderCategoryTile(product) {
  const media = product.imageUrl
    ? `<img class="category-tile-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}" alt="" loading="lazy" decoding="async">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  return `
    <a class="category-tile" data-product-id="${escapeHtml(product.productId)}"
       href="product.html?store=${encodeURIComponent(product.storeSlug)}&product=${encodeURIComponent(product.productId)}">
      ${media}
      <span class="category-tile-name">${escapeHtml(product.name)}</span>
    </a>
  `;
}

function onShowMore() {
  shownCount += CATEGORY_PAGE_SIZE;
  render();
}
