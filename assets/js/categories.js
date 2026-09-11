// Browse AND search: a rail of categories on the left, products on the right,
// swapped in place rather than by navigating.
//
// This page absorbed search.html, which is gone. It has two modes:
//
//   browse  (no ?q=)  a category is selected on the rail; the header box
//                     live-filters what has already been fetched, which is
//                     instant and works on a dead connection.
//   search  (?q=x)    one site-wide query across every category. The rail has
//                     no selection, because the answer is not confined to one.
//
// Submitting the header box enters search mode; tapping a category leaves it.
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
// What the shopper typed in the header box. Filters the category already
// fetched rather than asking the backend again - the whole match set is
// already here, so this is instant and works with a dead connection.
let searchTerm = '';
// The site-wide query from ?q=. Distinct from searchTerm, which only filters
// what is already on screen: siteQuery is what the backend was asked.
let siteQuery = '';
// ?type= - product | rental | service. There is no visible control for it: the
// [All|Products|Rentals|Services] chips were removed, and search.html, which
// used to be the only thing reading this, is gone. It still has to work,
// because SMART SEARCH BUILDS THESE LINKS ITSELF - discoveryHref below sends
// "somewhere to stay" to category=property&type=rental so a shopper after a
// room is not shown land for sale. Dropping it would quietly undo that.
let currentType = '';
// Admin-curated featured items, fetched once. Never re-fetched on a rail tap.
let featuredProducts = null;
// Results are cached per category for the life of the page, so flicking back
// and forth along the rail doesn't re-hit a backend that takes a second to
// answer on a mobile connection.
const categoryCache = {};

async function init() {
  renderRail();
  document.getElementById('category-more').addEventListener('click', onShowMore);
  homeMoreButton();
  wireBrowseSearch();
  // Deliberately not awaited: the featured strip is editorial garnish and must
  // never hold up the products the shopper came for.
  loadFeatured();

  currentType = getQueryParam('type') || '';
  const q = (getQueryParam('q') || '').trim();
  if (q) {
    document.getElementById('browse-search-input').value = q;
    await runSiteSearch(q, { replaceUrl: false });
    return;
  }

  const requested = getQueryParam('category');
  // An unknown slug (a stale link, a renamed category) falls back to the first
  // rather than rendering an empty page with nothing selected.
  const known = activeCategories().some((c) => c.id === requested);
  await selectCategory(known ? requested : activeCategories()[0].id, { replaceUrl: false });
}

/**
 * One query across every category - what search.html used to do.
 *
 * Deliberately NOT cached in categoryCache: that map is keyed by category and
 * a query is not a category. A repeated search re-asks the backend, which is
 * right - actionSearchProducts caches for 60s server-side anyway.
 */
async function runSiteSearch(q, opts) {
  siteQuery = q;
  // A query is not confined to one category, so nothing on the rail is the
  // answer. currentCategory is cleared so a later tap on ANY category counts
  // as a change and re-enters browse mode.
  currentCategory = '';
  searchTerm = '';
  shownCount = CATEGORY_PAGE_SIZE;
  markSelected('');

  const pane = document.querySelector('.category-pane');
  if (pane) pane.scrollTop = 0;

  document.getElementById('category-pane-heading').textContent = `Results for "${q}"`;
  document.title = `${q} — Mwakete`;

  if (!opts || opts.replaceUrl !== false) {
    history.replaceState(null, '', `${location.pathname}?q=${encodeURIComponent(q)}`);
  }

  const statusEl = document.getElementById('category-status');
  const listEl = document.getElementById('category-list');
  listEl.innerHTML = '';
  document.getElementById('category-more').hidden = true;
  hideDiscovery();
  const stopLoading = startLoadingMessage(statusEl);

  const res = await Api.get('searchProducts', { q: q, type: currentType });
  stopLoading();

  if (!res || !res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  categoryProducts = res.products || [];
  render();
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
  // activeCategories(), not CATEGORIES: ordered by display_order and excluding
  // anything switched off, so retiring a category is a data change rather than
  // an edit here. This page is "view all", so unlike the homepage strip it
  // deliberately shows every one, Other included.
  document.getElementById('category-rail').innerHTML = activeCategories().map((c) => `
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
  // Leaving search mode. The box is cleared too: leaving the query sitting in
  // it next to a category's products would say the results were filtered by it.
  if (siteQuery) {
    siteQuery = '';
    hideDiscovery();
    const input = document.getElementById('browse-search-input');
    if (input) input.value = '';
  }
  currentCategory = categoryId;
  shownCount = CATEGORY_PAGE_SIZE;
  markSelected(categoryId);

  // A new category is a new list, so start it at item one. Without this, a
  // shopper scrolled halfway down Food and tapping Fishing lands in the middle
  // of a list whose start they never saw. The pane is its own scroller now
  // (body.browse-locked in styles.css), so this is the element that moves -
  // window.scrollTo would do nothing, the document does not scroll here.
  const pane = document.querySelector('.category-pane');
  if (pane) pane.scrollTop = 0;

  const meta = categoryById(categoryId);
  document.getElementById('category-pane-heading').textContent = meta ? meta.label : 'Browse';
  document.title = `${meta ? meta.label : 'Browse'} — Mwakete`;

  // Keep the URL honest so a refresh, a back button or a shared link all land
  // on the category the shopper is actually looking at. replaceState, not
  // pushState: the rail is a filter, not a place, and stacking history entries
  // would make Back walk through every category they tried.
  if (!opts || opts.replaceUrl !== false) {
    // type rides along: a shopper who arrived on rentals stays on rentals while
    // moving along the rail.
    const params = new URLSearchParams();
    params.set('category', categoryId);
    if (currentType) params.set('type', currentType);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
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

  const request = Api.get('searchProducts', { category: categoryId, type: currentType });
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

/**
 * The header box filters the category already on screen.
 *
 * No backend call: selectCategory has fetched the whole match set for this
 * category, so filtering is instant and keeps working on a connection too slow
 * to answer another request. Typing never leaves the page, so the rail keeps
 * its meaning - a shopper is always inside exactly one category.
 */
function wireBrowseSearch() {
  const form = document.getElementById('browse-search-form');
  const input = document.getElementById('browse-search-input');
  if (!form || !input) return;
  // Submitting searches the WHOLE marketplace - this box replaced the one on
  // search.html, so it has to be able to leave the current category. It never
  // reloads the page; the results swap in like a rail tap does.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    runSiteSearch(q);
  });

  input.addEventListener('input', () => {
    // Live filtering applies to what is already on screen. In search mode that
    // would narrow the results of a query with a second, invisible query -
    // two filters in one box - so typing there only arms the submit.
    if (siteQuery) return;
    searchTerm = input.value.trim().toLowerCase();
    shownCount = CATEGORY_PAGE_SIZE;
    render();
  });
}

/** Name and description, the two fields a shopper is actually typing at. */
function matchesSearch(p) {
  if (!searchTerm) return true;
  return `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(searchTerm);
}

function render() {
  const statusEl = document.getElementById('category-status');
  const listEl = document.getElementById('category-list');
  const moreEl = document.getElementById('category-more');

  const matches = categoryProducts.filter(matchesSearch);
  renderFeatured();

  if (matches.length === 0) {
    listEl.innerHTML = '';
    moreEl.hidden = true;
    // Three empty states now, not two. A site-wide search that found nothing
    // is the one worth working on - it is where smart search reads the phrase
    // and offers a category instead of a dead end.
    if (siteQuery) {
      statusEl.textContent = `No exact match for "${siteQuery}".`;
      runDiscovery();
      return;
    }
    statusEl.textContent = searchTerm
      ? `Nothing in this category matches "${searchTerm}".`
      : 'Nothing in this category yet — try another, or search for what you need.';
    return;
  }

  // Results are showing, so nothing about discovery applies.
  hideDiscovery();

  const page = matches.slice(0, Math.max(CATEGORY_PAGE_SIZE, shownCount));
  const noun = `product${matches.length === 1 ? '' : 's'}`;
  statusEl.textContent = page.length < matches.length
    ? `Showing ${page.length} of ${matches.length} ${noun}.`
    : `${matches.length} ${noun}.`;

  listEl.innerHTML = page.map(renderCategoryTile).join('');
  moreEl.hidden = page.length >= matches.length;
  recordProductViewsOnce(page.map((p) => p.productId));
}

/**
 * Featured items, from the admin-curated Featured sheet.
 *
 * Read-only here and admin-only there: addFeatured/removeFeatured are gated by
 * isOwnerAdmin, so a seller cannot place themselves at the top of a category.
 * Best-effort - a failure leaves the strip hidden and the page unchanged.
 */
async function loadFeatured() {
  const res = await Api.get('getTips', {});
  featuredProducts = (res && res.ok && Array.isArray(res.products)) ? res.products : [];
  renderFeatured();
}

function renderFeatured() {
  const strip = document.getElementById('featured-strip');
  const listEl = document.getElementById('featured-list');
  if (!strip || !listEl || featuredProducts === null) return;

  // categoryIdOf, not a raw compare: getTips emits the SHEET's Category value
  // untouched (Admin.gs buildTips), so a legacy 'pantry' would never match
  // 'food' and the item would silently never appear. Every other read path maps
  // this on the way through; this one has to do it here.
  const mine = featuredProducts
    .filter((p) => categoryIdOf(p.category) === currentCategory)
    .filter(matchesSearch);

  strip.hidden = mine.length === 0;
  listEl.innerHTML = mine.map(renderCategoryTile).join('');
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
    ? `<img class="category-tile-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}"${srcsetAttr(product.imageUrl, IMG_SIZES_TILE)} alt="" loading="lazy" decoding="async">`
    : `<div class="placeholder-swatch category-${escapeHtml(categoryIdOf(product.category))}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

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

/**
 * Puts the ONE "More..." button where it belongs for the current viewport.
 *
 * The same element either way - moved, never duplicated - so its click
 * handler, its hidden state and everything render() does to it carry across
 * untouched. A second copy in the nav would be a second thing to keep in sync
 * with how much of the category is already shown.
 *
 * The bottom nav is display:none above 700px (styles.css), so on a desktop
 * the button has to stay in the page or it would be invisible and the paging
 * unreachable. matchMedia re-homes it when the window is resized or a phone is
 * rotated across that boundary.
 */
function homeMoreButton() {
  const btn = document.getElementById('category-more');
  const inPage = document.querySelector('.load-more-row');
  if (!btn || !inPage) return;

  const mq = window.matchMedia('(max-width: 700px)');
  const place = () => {
    const slot = document.getElementById('bottom-nav-more-slot');
    const target = mq.matches && slot ? slot : inPage;
    if (btn.parentElement !== target) target.appendChild(btn);
  };

  place();
  // bottom-nav.js builds the slot on DOMContentLoaded too, and script order
  // is not a guarantee worth relying on - try again once the frame settles.
  requestAnimationFrame(place);
  if (mq.addEventListener) mq.addEventListener('change', place);
  else if (mq.addListener) mq.addListener(place);
}

/* ---------- smart search discovery ----------
 *
 * Moved here from search.html, which this page replaced. Runs ONLY when a
 * site-wide query returned nothing, so a search that works never consults the
 * intent dictionary and costs nothing.
 *
 * ONE extra backend request, and only when a category is identified confidently
 * enough to fill the pane with it. Everything else is answered from data
 * already in the browser.
 */

// The phrase the current discovery pass was built for, so a re-render cannot
// re-issue the fetch.
let discoveryFor = null;

function hideDiscovery() {
  const el = document.getElementById('search-discovery');
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
  discoveryFor = null;
}

/**
 * What this search actually did, in one object - the phrase, whether anything
 * was found, what it was read as and how sure we were. It drives the UI below
 * and is deliberately the shape an analytics call would want.
 */
function searchOutcome() {
  const intent = typeof detectSearchIntent === 'function'
    ? detectSearchIntent(siteQuery)
    : { confidence: 'empty', matches: [], cheap: false };
  return {
    query: siteQuery,
    resultCount: categoryProducts.length,
    confidence: intent.confidence,
    cheap: intent.cheap,
    // Only categories that really exist reach the screen. The dictionary is
    // written against CATEGORIES, but a stale service-worker copy of one file
    // and not the other would otherwise render a chip that leads nowhere.
    matches: intent.matches.filter((m) => categoryById(m.category))
  };
}

function discoveryHref(match) {
  const params = new URLSearchParams();
  params.set('category', match.category);
  if (match.listingType) params.set('type', match.listingType);
  return 'categories.html?' + params.toString();
}

function renderDiscoveryChips(matches) {
  // With one suggestion the lead line has already named the category, so a
  // chip repeating that name is a word said twice. Make it the action instead.
  const lone = matches.length === 1;
  const items = matches
    .map((m) => {
      const meta = categoryById(m.category);
      if (!meta) return '';
      const text = lone ? `See all ${meta.label}` : meta.label;
      return `<a class="chip-strip-item" href="${escapeAttr(discoveryHref(m))}">${escapeHtml(text)}</a>`;
    })
    .filter(Boolean)
    .join('');
  return `<nav class="chip-strip search-discovery-chips" aria-label="Suggested categories">${items}</nav>`;
}

async function runDiscovery() {
  const el = document.getElementById('search-discovery');
  if (!el || typeof detectSearchIntent !== 'function') return;
  if (discoveryFor === siteQuery) return;
  discoveryFor = siteQuery;

  const outcome = searchOutcome();
  const matches = outcome.matches;
  const statusEl = document.getElementById('category-status');

  if (!matches.length) {
    // Nothing readable in the phrase. Two different messages, because "help"
    // and "xyzabc123" are different problems: one shopper has not said what
    // they want, the other said something we do not stock.
    el.innerHTML =
      `<p class="search-discovery-lead">${outcome.confidence === 'empty'
        ? 'What are you looking for?'
        : 'Try a product name, a category, a store, or a service.'}</p>` +
      renderDiscoveryChips(popularCategories().map((c) => ({ category: c.id, listingType: '' })));
    el.hidden = false;
    statusEl.innerHTML = `<strong>No exact match for "${escapeHtml(siteQuery)}".</strong>`;
    return;
  }

  const first = categoryById(matches[0].category);
  el.innerHTML =
    `<p class="search-discovery-lead">${outcome.confidence === 'high'
      ? `Looking for ${escapeHtml(first.label)}?`
      : 'You may be looking for'}</p>` +
    renderDiscoveryChips(matches);
  el.hidden = false;
  statusEl.innerHTML = `<strong>No exact match for "${escapeHtml(siteQuery)}".</strong>`;

  await showDiscoveryProducts(matches[0], first.label);
}

async function showDiscoveryProducts(match, label) {
  const listEl = document.getElementById('category-list');
  const el = document.getElementById('search-discovery');
  // No q: the phrase is what failed. Ask for the category instead.
  const res = await Api.get('searchProducts', { q: '', category: match.category, type: match.listingType || '' });
  // A second search may have started while this was in flight.
  if (discoveryFor !== siteQuery) return;
  if (!res || !res.ok || !(res.products || []).length) return;

  const page = (res.products || []).slice(0, CATEGORY_PAGE_SIZE);
  el.insertAdjacentHTML('beforeend',
    `<h2 class="section-title-sm">Popular in ${escapeHtml(label)}</h2>`);
  // renderCategoryTile, like every other result on this page. The fuller card
  // was the right one on search.html's full-width grid, but this pane is
  // narrower - the rail takes its share - and mixing the two would make the
  // suggested products look like a different kind of thing from the ones above.
  listEl.innerHTML = page.map(renderCategoryTile).join('');
  recordProductViewsOnce(page.map((p) => p.productId));
}
