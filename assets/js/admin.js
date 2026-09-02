document.addEventListener('DOMContentLoaded', init);

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  if (!owner.isAdmin) {
    document.getElementById('admin-denied').classList.remove('hidden');
    return;
  }
  document.getElementById('admin-tools').classList.remove('hidden');

  await loadStores();
  document.getElementById('feature-store-btn').addEventListener('click', onFeatureStore);
  document.getElementById('prod-store-select').addEventListener('change', onPickStoreForProduct);
  document.getElementById('feature-product-btn').addEventListener('click', onFeatureProduct);
  loadFeatured();
}

async function loadStores() {
  const res = await Api.get('listStores', {});
  const stores = res.ok ? (res.stores || []) : [];
  const opts = ['<option value="">Choose a store…</option>']
    .concat(stores.map((s) => `<option value="${escapeHtml(s.storeSlug)}">${escapeHtml(s.storeName)}</option>`))
    .join('');
  document.getElementById('store-select').innerHTML = opts;
  document.getElementById('prod-store-select').innerHTML = opts;
}

async function onPickStoreForProduct() {
  const slug = document.getElementById('prod-store-select').value;
  const sel = document.getElementById('product-select');
  if (!slug) {
    sel.innerHTML = '<option value="">Choose a store first…</option>';
    return;
  }
  sel.innerHTML = '<option value="">Loading…</option>';
  const res = await Api.get('listProducts', { storeSlug: slug });
  const products = res.ok ? (res.products || []) : [];
  sel.innerHTML = ['<option value="">Choose a product…</option>']
    .concat(products.map((p) => `<option value="${escapeHtml(p.productId)}">${escapeHtml(p.name)}</option>`))
    .join('');
}

function onFeatureStore() {
  const slug = document.getElementById('store-select').value;
  if (slug) addFeatured('store', slug);
}

function onFeatureProduct() {
  const pid = document.getElementById('product-select').value;
  if (pid) addFeatured('product', pid);
}

async function addFeatured(type, refId) {
  const errorEl = document.getElementById('admin-error');
  errorEl.textContent = '';
  const res = await Api.post('addFeatured', { token: Auth.getToken(), type, refId });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not add that item.';
    return;
  }
  loadFeatured();
}

async function loadFeatured() {
  const statusEl = document.getElementById('featured-status');
  const listEl = document.getElementById('featured-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listFeatured', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const items = res.featured || [];
  if (items.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = 'Nothing featured yet.';
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = items.map(featuredRow).join('');
  listEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(btn.dataset.remove));
  });
}

function featuredRow(f) {
  return `
    <div class="dash-item">
      <div class="dash-item-main">
        <strong>${escapeHtml(f.label)}</strong>
        <span class="helper-text">${escapeHtml(f.type)}</span>
      </div>
      <div class="dash-item-side">
        <button type="button" class="btn btn-small btn-danger" data-remove="${escapeHtml(f.featuredId)}">Remove</button>
      </div>
    </div>`;
}

async function onRemove(featuredId) {
  const res = await Api.post('removeFeatured', { token: Auth.getToken(), featuredId });
  if (res.ok) loadFeatured();
}
