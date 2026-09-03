document.addEventListener('DOMContentLoaded', init);

// The directory only ever asks for "the top N stores" and re-fetches from
// the start when N grows (same shape as owner-messages.js's conversation
// list pagination) rather than true offset-cursor paging - simpler, and
// avoids any skip/duplicate risk if the underlying list ever changes
// between calls. At 10k+ vendors this is what keeps the initial page load
// and DOM render bounded instead of rendering every store at once - see
// docs/production-readiness-report.md Finding 10.
const STORE_PAGE_SIZE = 20;
let storesLoadedLimit = STORE_PAGE_SIZE;
let storesHasMore = false;
let storesQuery = '';

async function init() {
  document.getElementById('stores-load-more').addEventListener('click', onLoadMore);
  wireStoresSearch();
  // Not awaited: the pinned cards are a bonus for a few shoppers, and the main
  // directory must not wait on them. Deferred past the main list (whenIdle,
  // helpers.js) so they never compete with it for the connection.
  whenIdle(loadCartStores);
  await loadStores();
}

// Live-filters as the customer types (debounced), same as any other search
// box on the site - Enter/Search button also works but isn't required.
function wireStoresSearch() {
  const form = document.getElementById('stores-search-form');
  const input = document.getElementById('stores-search-input');
  let debounceTimer = null;

  function runSearch() {
    storesQuery = input.value.trim();
    storesLoadedLimit = STORE_PAGE_SIZE;
    loadStores();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    runSearch();
  });

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 300);
  });
}

async function loadStores() {
  const statusEl = document.getElementById('stores-status');
  const stopLoading = startLoadingMessage(statusEl);
  const request = Api.get('listStores', { limit: storesLoadedLimit, q: storesQuery });
  // The request this page paints from; whenIdle() waits for it (helpers.js).
  window.__criticalReady = request;
  const res = await request;
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  if (res.stores.length === 0) {
    statusEl.textContent = storesQuery
      ? `No stores match "${storesQuery}" — try a different island or village.`
      : 'No stores are open yet — check back soon.';
    document.getElementById('store-list').innerHTML = '';
    document.getElementById('stores-load-more').classList.add('hidden');
    return;
  }

  storesHasMore = !!res.hasMore;
  statusEl.textContent = `${res.stores.length} of ${res.total} store${res.total === 1 ? '' : 's'} shown.`;
  document.getElementById('store-list').innerHTML = res.stores.map((store) => renderStoreCard(store)).join('');
  document.getElementById('stores-load-more').classList.toggle('hidden', !storesHasMore);
  // Search and Load More both rebuild the list, so the markers go back on here
  // rather than once at startup.
  markCartStoresInList();
}

async function onLoadMore() {
  storesLoadedLimit += STORE_PAGE_SIZE;
  await loadStores();
}

/**
 * Slugs this device has a non-empty cart for. Carts are per-store
 * (skiri_cart_<slug>, see cart.js), so a shopper who browsed three shops has
 * three of them and no way back to any but the one they remember.
 *
 * Same localStorage scan as bottom-nav.js's updateBottomNavCartBadge and
 * customer-messages.js's collectChatStores, including their try/catch: storage
 * can be unavailable in private mode, and a malformed entry must not take the
 * page down with it.
 */
function cartStoreSlugs() {
  const prefix = 'skiri_cart_';
  const slugs = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        const slug = key.slice(prefix.length);
        if (!slug) continue;
        try {
          const cart = JSON.parse(localStorage.getItem(key));
          if (Array.isArray(cart) && cart.length > 0) slugs.push(slug);
        } catch (e) { /* skip malformed cart */ }
      }
    }
  } catch (e) {
    // storage unavailable - treated as no carts
  }
  return slugs;
}

/**
 * Fetches each cart store by slug rather than re-sorting what listStores
 * returned. listStores is paginated server-side, so a store the shopper has a
 * cart with may not be in the loaded page at all - and re-sorting would then
 * silently drop the very cart this exists to resurface.
 *
 * A lookup that fails (store closed, slug gone) just drops that card. It never
 * clears the cart: a failed request is not proof the store is gone, and the
 * cart is the shopper's, not ours to delete.
 */
/**
 * The row's space is reserved before the first paint by the inline script in
 * stores.html's <head> plus .cart-stores in styles.css - it has to be, since
 * anything JS does here happens after that paint and would shove the directory
 * down the page. Nothing to do at init.
 *
 * What is left for JS is releasing the reservation once the real cards are in
 * (is-loaded), or taking the row away if every lookup failed.
 */
function hideCartStores() {
  const section = document.getElementById('cart-stores');
  document.getElementById('cart-store-list').innerHTML = '';
  section.classList.add('is-loaded');
  section.classList.add('hidden');
}

async function loadCartStores() {
  const slugs = cartStoreSlugs();
  if (slugs.length === 0) return;

  const results = await Promise.all(
    slugs.map((slug) => Api.get('getStorePublicInfo', { storeSlug: slug }).catch(() => null))
  );
  const stores = results
    .map((res, i) => (res && res.ok && res.store ? Object.assign({ storeSlug: slugs[i] }, res.store) : null))
    .filter(Boolean);
  if (stores.length === 0) {
    // Every lookup failed - take the reserved space back rather than leave a
    // blank row sitting there. The carts themselves are untouched.
    hideCartStores();
    return;
  }

  document.getElementById('cart-store-list').innerHTML =
    stores.map((store) => renderStoreCard(store, { resume: true })).join('');
  // Real cards are in; release the reserved height so the row sizes to them.
  document.getElementById('cart-stores').classList.add('is-loaded');
  markCartStoresInList();
}

/**
 * Marks cards in the main directory that the shopper already has a cart with.
 *
 * Must run after EVERY render of #store-list: a search re-run and Load More
 * both rebuild it from scratch, which would wipe the markers. Same trap
 * disableOrderingControls hits in store.js, so it is called from the same
 * place - the end of loadStores - as well as after the pinned section renders.
 */
function markCartStoresInList() {
  const slugs = cartStoreSlugs();
  if (slugs.length === 0) return;
  document.querySelectorAll('#store-list .store-card').forEach((card) => {
    const slug = card.dataset.storeSlug;
    if (!slug || slugs.indexOf(slug) === -1) return;
    card.classList.add('is-in-cart');
    if (card.querySelector('.store-card-cart-flag')) return;
    const flag = document.createElement('span');
    flag.className = 'store-card-cart-flag';
    // A visible label, not just a border colour - the marker must not depend
    // on colour alone to be understood.
    flag.textContent = 'In your cart';
    (card.querySelector('.store-card-info') || card).prepend(flag);
  });
}

/**
 * opts.resume appends a "Continue shopping" pill INSIDE the existing anchor
 * rather than nesting a second control, so the whole card stays one large
 * touch target. No item count or total: the plan is a way back to the shop,
 * not a second cart summary.
 */
function renderStoreCard(store, opts) {
  const resume = !!(opts && opts.resume);
  const logo = store.logoUrl
    ? `<img class="store-card-logo" src="${escapeHtml(optimizedImageUrl(store.logoUrl, IMG_W.logo))}" alt="" loading="lazy" decoding="async">`
    : `<div class="store-card-logo-placeholder" aria-hidden="true">${escapeHtml(initials(store.storeName))}</div>`;

  const location = storeLocationLabel(store.island, store.village);
  const displayName = location ? `${store.storeName} | ${location}` : store.storeName;

  return `
    <a class="store-card${resume ? ' store-card--resume' : ''}" data-store-slug="${escapeHtml(store.storeSlug)}" href="store.html?store=${encodeURIComponent(store.storeSlug)}">
      ${logo}
      <div class="store-card-info">
        <h3>${escapeHtml(displayName)}</h3>
        <div class="store-card-meta">
          ${store.phone ? `<span class="store-phone">${escapeHtml(store.phone)}</span>` : ''}
          ${renderDeliveryIcons({
            truck: store.deliveryTruck,
            ship: store.deliveryShip,
            airCargo: store.deliveryAirCargo,
            pickPay: store.deliveryPickPay,
            truckCost: store.deliveryTruckCost,
            shipCost: store.deliveryShipCost,
            airCargoCost: store.deliveryAirCargoCost
          })}
        </div>
        <p class="helper-text">${resume ? '<span class="store-card-resume">Continue shopping →</span>' : 'Visit store →'}</p>
      </div>
    </a>
  `;
}
