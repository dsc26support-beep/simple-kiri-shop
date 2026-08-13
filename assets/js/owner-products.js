document.addEventListener('DOMContentLoaded', init);

const PRODUCTS_PAGE_SIZE = 20;
let ownerProducts = [];
let productsHasMore = false;
let productsTotal = 0;
let selectedImageFile = null;
let selectedImageFile2 = null;
let variantRowSeq = 0;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('add-product-btn').addEventListener('click', () => openForm(null));
  document.getElementById('cancel-product-btn').addEventListener('click', closeForm);
  document.getElementById('add-variant-btn').addEventListener('click', () => addVariantRow());
  document.getElementById('product-form').addEventListener('submit', onSaveProduct);
  document.getElementById('product-image-input').addEventListener('change', onImageFileChange);
  document.getElementById('product-image-input-2').addEventListener('change', onImageFileChange2);
  document.getElementById('owner-product-list').addEventListener('click', onListClick);
  document.getElementById('products-load-more').addEventListener('click', onLoadMore);

  await loadProducts();
}

/**
 * Re-requests "the top N products" each time, growing N via Load More -
 * same limit-only shape as owner-orders.js/directory.js/owner-messages.js's
 * conversation list, so a save/archive that calls this with no opts (see
 * onArchive/onSaveProduct below) preserves whatever page depth the vendor
 * had already reached instead of resetting to page 1.
 */
async function loadProducts(opts) {
  const limit = (opts && opts.limit) || ownerProducts.length || PRODUCTS_PAGE_SIZE;
  const statusEl = document.getElementById('products-status');
  const stopLoading = startLoadingMessage(statusEl);
  const res = await Api.post('listOwnerProducts', { token: Auth.getToken(), limit });
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  ownerProducts = res.products;
  productsHasMore = !!res.hasMore;
  productsTotal = res.total;
  statusEl.textContent = ownerProducts.length === 0 ? 'You have no products yet — add your first one above.' : `${ownerProducts.length} of ${res.total} product(s) shown.`;
  document.getElementById('products-load-more').classList.toggle('hidden', !productsHasMore);
  renderList();
}

function onLoadMore() {
  loadProducts({ limit: ownerProducts.length + PRODUCTS_PAGE_SIZE });
}

function renderList() {
  const listEl = document.getElementById('owner-product-list');
  listEl.innerHTML = ownerProducts
    .map((p) => {
      const media = p.imageUrl
        ? `<img src="${escapeHtml(p.imageUrl)}" alt="">`
        : `<div class="placeholder-swatch category-${escapeHtml(p.category || 'general')}" aria-hidden="true">${escapeHtml(initials(p.name))}</div>`;
      const activeVariants = p.variants.filter((v) => v.status === 'active');
      const priceRange = activeVariants.length
        ? activeVariants.map((v) => formatMoney(v.price)).join(' / ')
        : 'No varieties yet';
      return `
        <div class="owner-product-row" data-product-id="${escapeHtml(p.productId)}">
          ${media}
          <div class="row-info">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="status-badge status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
            <div class="helper-text">${priceRange}</div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn btn-small" data-action="edit">Edit</button>
            <button type="button" class="btn btn-small btn-danger" data-action="archive">Archive</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function onListClick(e) {
  const row = e.target.closest('.owner-product-row');
  if (!row) return;
  const productId = row.dataset.productId;
  const product = ownerProducts.find((p) => p.productId === productId);

  if (e.target.closest('[data-action="edit"]')) {
    openForm(product);
  } else if (e.target.closest('[data-action="archive"]')) {
    onArchive(product);
  }
}

async function onArchive(product) {
  if (!confirm(`Archive "${product.name}"? It will no longer be visible to customers.`)) return;
  const res = await Api.post('deleteProduct', { token: Auth.getToken(), productId: product.productId });
  if (!res.ok) {
    alert(res.error || 'Could not archive this product.');
    return;
  }
  await loadProducts();
}

function openForm(product) {
  const section = document.getElementById('product-form-section');
  const heading = document.getElementById('product-form-heading');
  section.classList.remove('hidden');
  selectedImageFile = null;
  selectedImageFile2 = null;
  document.getElementById('product-image-input').value = '';
  document.getElementById('product-image-input-2').value = '';
  document.getElementById('product-form-error').textContent = '';

  const preview = document.getElementById('image-preview');
  const preview2 = document.getElementById('image-preview-2');
  document.getElementById('variant-rows').innerHTML = '';

  if (product) {
    heading.textContent = `Edit: ${product.name}`;
    document.getElementById('product-id').value = product.productId;
    document.getElementById('product-name').value = product.name;
    document.getElementById('product-description').value = product.description || '';
    document.getElementById('product-category').value = product.category || 'general';
    document.getElementById('product-status').value = product.status || 'active';
    if (product.imageUrl) {
      preview.src = product.imageUrl;
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
    if (product.imageUrl2) {
      preview2.src = product.imageUrl2;
      preview2.classList.remove('hidden');
    } else {
      preview2.classList.add('hidden');
    }
    const activeVariants = product.variants.filter((v) => v.status === 'active');
    if (activeVariants.length === 0) addVariantRow();
    else activeVariants.forEach((v) => addVariantRow(v));
  } else {
    heading.textContent = 'Add Product';
    document.getElementById('product-id').value = '';
    document.getElementById('product-name').value = '';
    document.getElementById('product-description').value = '';
    document.getElementById('product-category').value = 'general';
    document.getElementById('product-status').value = 'active';
    preview.classList.add('hidden');
    preview2.classList.add('hidden');
    addVariantRow();
  }

  section.scrollIntoView({ behavior: 'smooth' });
}

function closeForm() {
  document.getElementById('product-form-section').classList.add('hidden');
}

function addVariantRow(variant) {
  variantRowSeq++;
  const rowId = `variant-row-${variantRowSeq}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'variant-row';
  wrapper.dataset.variantId = variant ? variant.variantId : '';
  wrapper.innerHTML = `
    <div class="field">
      <label for="${rowId}-label">Label (e.g. 500g, Large)</label>
      <input id="${rowId}-label" class="variant-label" value="${variant ? escapeHtml(variant.label) : ''}" required>
    </div>
    <div class="field">
      <label for="${rowId}-price">Price</label>
      <input id="${rowId}-price" class="variant-price" type="number" min="0" step="0.01" value="${variant ? variant.price : ''}" required>
    </div>
    <button type="button" class="btn btn-small btn-danger remove-variant-btn">Remove</button>
  `;
  wrapper.querySelector('.remove-variant-btn').addEventListener('click', () => wrapper.remove());
  document.getElementById('variant-rows').appendChild(wrapper);
}

function onImageFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedImageFile = file;
  const preview = document.getElementById('image-preview');
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function onImageFileChange2(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedImageFile2 = file;
  const preview = document.getElementById('image-preview-2');
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function setSaveProductBusy(saveBtn, label) {
  saveBtn.disabled = true;
  saveBtn.innerHTML = `${label}<span class="btn-saving-dots"><span></span><span></span><span></span></span>`;
}

function setSaveProductIdle(saveBtn) {
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Product';
}

async function onSaveProduct(e) {
  e.preventDefault();
  const errorEl = document.getElementById('product-form-error');
  errorEl.textContent = '';

  const variants = Array.from(document.querySelectorAll('#variant-rows .variant-row')).map((row) => ({
    variantId: row.dataset.variantId || undefined,
    label: row.querySelector('.variant-label').value.trim(),
    price: parseFloat(row.querySelector('.variant-price').value)
  }));

  if (variants.some((v) => !v.label || isNaN(v.price) || v.price < 0)) {
    errorEl.textContent = 'Please fill in a label and a valid price for every variety.';
    return;
  }
  if (variants.length === 0) {
    errorEl.textContent = 'Add at least one variety (e.g. a size or pack) with a price.';
    return;
  }

  const productId = document.getElementById('product-id').value || undefined;
  const payload = {
    token: Auth.getToken(),
    productId,
    name: document.getElementById('product-name').value.trim(),
    description: document.getElementById('product-description').value.trim(),
    category: document.getElementById('product-category').value,
    status: document.getElementById('product-status').value,
    variants
  };

  const saveBtn = document.getElementById('save-product-btn');
  setSaveProductBusy(saveBtn, productId ? 'Saving' : 'Adding');

  const action = productId ? 'updateProduct' : 'createProduct';
  const res = await Api.post(action, payload);

  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not save this product.';
    setSaveProductIdle(saveBtn);
    return;
  }

  if (selectedImageFile) {
    setSaveProductBusy(saveBtn, 'Uploading photo 1');
    try {
      const { base64, mimeType } = await compressImage(selectedImageFile);
      const uploadRes = await Api.post('uploadProductImage', {
        token: Auth.getToken(),
        productId: res.productId,
        imageBase64: base64,
        mimeType,
        slot: 1
      });
      if (!uploadRes.ok) {
        errorEl.textContent = `Product saved, but photo 1 upload failed: ${uploadRes.error || 'unknown error'}`;
      }
    } catch (err) {
      errorEl.textContent = 'Product saved, but photo 1 could not be processed.';
    }
  }

  if (selectedImageFile2) {
    setSaveProductBusy(saveBtn, 'Uploading photo 2');
    try {
      const { base64, mimeType } = await compressImage(selectedImageFile2);
      const uploadRes = await Api.post('uploadProductImage', {
        token: Auth.getToken(),
        productId: res.productId,
        imageBase64: base64,
        mimeType,
        slot: 2
      });
      if (!uploadRes.ok) {
        errorEl.textContent = `Product saved, but photo 2 upload failed: ${uploadRes.error || 'unknown error'}`;
      }
    } catch (err) {
      errorEl.textContent = 'Product saved, but photo 2 could not be processed.';
    }
  }

  setSaveProductIdle(saveBtn);
  closeForm();
  // A brand-new product lands past the END of append order (a new Sheet row
  // is always appended, never inserted at the front), at position
  // productsTotal (0-indexed) - the total BEFORE this save. Growing the
  // limit by just ownerProducts.length+1 (how much is currently ON SCREEN)
  // would only work if the vendor had already loaded everything; if they're
  // still on page 1, that undercounts and would silently show a different
  // *existing* product instead of the new one. productsTotal+1 is always
  // enough regardless of how much was loaded. An edit doesn't change the
  // total, so it reuses the plain "reload what's currently visible" path
  // (loadProducts() with no opts).
  await loadProducts(productId ? undefined : { limit: productsTotal + 1 });
}
