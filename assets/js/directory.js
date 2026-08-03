document.addEventListener('DOMContentLoaded', init);

async function init() {
  const listEl = document.getElementById('store-list');
  const statusEl = document.getElementById('stores-status');

  const res = await Api.get('listStores', {});
  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not load stores right now. Please try again later.';
    return;
  }

  if (res.stores.length === 0) {
    statusEl.textContent = 'No stores are open yet — check back soon.';
    return;
  }

  statusEl.textContent = `${res.stores.length} store${res.stores.length === 1 ? '' : 's'} available.`;
  listEl.innerHTML = res.stores.map(renderStoreCard).join('');
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
          truckCost: store.deliveryTruckCost,
          shipCost: store.deliveryShipCost,
          airCargoCost: store.deliveryAirCargoCost
        })}
        <p class="helper-text">Visit store →</p>
      </div>
    </a>
  `;
}
