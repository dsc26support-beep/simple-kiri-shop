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

async function init() {
  document.getElementById('stores-load-more').addEventListener('click', onLoadMore);
  await loadStores();
}

async function loadStores() {
  const statusEl = document.getElementById('stores-status');
  const res = await Api.get('listStores', { limit: storesLoadedLimit });
  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not load stores right now. Please try again later.';
    return;
  }

  if (res.stores.length === 0) {
    statusEl.textContent = 'No stores are open yet — check back soon.';
    return;
  }

  storesHasMore = !!res.hasMore;
  statusEl.textContent = `${res.stores.length} of ${res.total} store${res.total === 1 ? '' : 's'} shown.`;
  document.getElementById('store-list').innerHTML = res.stores.map(renderStoreCard).join('');
  document.getElementById('stores-load-more').classList.toggle('hidden', !storesHasMore);
}

async function onLoadMore() {
  storesLoadedLimit += STORE_PAGE_SIZE;
  await loadStores();
}

function renderStoreCard(store) {
  const logo = store.logoUrl
    ? `<img class="store-card-logo" src="${escapeHtml(store.logoUrl)}" alt="">`
    : `<div class="store-card-logo-placeholder" aria-hidden="true">${escapeHtml(initials(store.storeName))}</div>`;

  const location = storeLocationLabel(store.island, store.village);
  const displayName = location ? `${store.storeName} | ${location}` : store.storeName;

  return `
    <a class="store-card" href="store.html?store=${encodeURIComponent(store.storeSlug)}">
      ${logo}
      <div class="store-card-info">
        <h3>${escapeHtml(displayName)}</h3>
        <div class="store-card-meta">
          ${store.phone ? `<span class="store-phone">${escapeHtml(store.phone)}</span>` : ''}
        </div>
        ${renderDeliveryIcons({
          truck: store.deliveryTruck,
          ship: store.deliveryShip,
          airCargo: store.deliveryAirCargo,
          pickPay: store.deliveryPickPay,
          truckCost: store.deliveryTruckCost,
          shipCost: store.deliveryShipCost,
          airCargoCost: store.deliveryAirCargoCost
        })}
        <p class="helper-text">Visit store →</p>
      </div>
    </a>
  `;
}
