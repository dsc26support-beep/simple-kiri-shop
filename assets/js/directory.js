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
  listEl.innerHTML = res.stores
    .map(
      (store) => `
      <a class="store-card" href="store.html?store=${encodeURIComponent(store.storeSlug)}">
        <h3>${escapeHtml(store.storeName)}</h3>
        ${store.phone ? `<p class="store-phone">${escapeHtml(store.phone)}</p>` : ''}
        <p class="helper-text">Visit store →</p>
      </a>
    `
    )
    .join('');
}
