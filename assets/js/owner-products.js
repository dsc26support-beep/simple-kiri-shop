document.addEventListener('DOMContentLoaded', init);

// The variety block is reused for rentals and services, where "Variety" reads
// wrong - a rental sells a duration, a service sells a named job. These relabel
// the section and each row's first field.
//
// Driven by the LISTING TYPE now, not the category. It used to key off
// 'rentals'/'services' as categories; those became types, and a rental can now
// sit in any category. Kept local to the owner form - it is portal copy, not
// shared logic.
//
// The label is now just the noun. The example moved into the input's
// placeholder: the label sits above EVERY row, so "Label (e.g. 500g, Large)"
// repeated the same parenthetical down the whole form, and on a narrow phone it
// wrapped onto two lines each time (see the seller's screenshot).
function varietyRowLabelText(listingType) {
  if (listingType === 'rental') return 'Duration';
  if (listingType === 'service') return 'Service Name';
  return 'Variety';
}
function varietyRowPlaceholderText(listingType) {
  if (listingType === 'rental') return 'e.g. ½ day, per day, per week';
  if (listingType === 'service') return 'e.g. Car Wash start price';
  return 'e.g. 500g, Large';
}
function varietiesSectionText(listingType) {
  if (listingType === 'rental') return 'Rental Durations & Prices';
  if (listingType === 'service') return 'Services & Prices';
  return 'Varieties & Prices';
}

/**
 * Fills the category picker with the categories that make sense for the chosen
 * listing type, so a seller offering a service is not scrolling past "Building
 * & Hardware". Other is always present, so there is never a listing that
 * cannot be filed.
 *
 * Keeps the current selection if it survives the narrowing - changing type
 * should not silently clear a category the seller already picked.
 */
function onListingTypeChange() {
  const type = document.getElementById('product-listing-type').value;
  fillCategoryOptions(type);
  updateVarietyLabels();
}

function fillCategoryOptions(listingType) {
  const select = document.getElementById('product-category');
  const previous = select.value;
  const list = activeCategories().filter(
    (c) => c.id === 'other' || !listingType || c.types.indexOf(listingType) !== -1
  );
  select.innerHTML = '<option value="" disabled' + (previous ? '' : ' selected') + '>Choose a category…</option>' +
    list.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
  if (previous && list.some((c) => c.id === previous)) select.value = previous;
}

const PRODUCTS_PAGE_SIZE = 20;
let ownerProducts = [];
let productsHasMore = false;
let productsTotal = 0;
let selectedImageFile = null;
// Second photos can no longer be UPLOADED. This only tracks whether the
// vendor asked to clear an existing one, so the payload can send imageUrl2: ''.
let clearPhoto2 = false;
let variantRowSeq = 0;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('add-product-btn').addEventListener('click', () => openForm(null));
  document.getElementById('cancel-product-btn').addEventListener('click', closeForm);
  document.getElementById('add-variant-btn').addEventListener('click', () => addVariantRow());
  document.getElementById('product-listing-type').addEventListener('change', onListingTypeChange);
  document.getElementById('product-form').addEventListener('submit', onSaveProduct);
  document.getElementById('product-image-input').addEventListener('change', onImageFileChange);
  document.getElementById('remove-photo2-btn').addEventListener('click', onRemovePhoto2);
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
        ? `<img src="${escapeHtml(optimizedImageUrl(p.imageUrl, IMG_W.thumb))}" alt="" loading="lazy" decoding="async">`
        : `<div class="placeholder-swatch category-${escapeHtml(categoryIdOf(p.category))}" aria-hidden="true">${escapeHtml(initials(p.name))}</div>`;
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
  clearPhoto2 = false;
  document.getElementById('product-image-input').value = '';
  document.getElementById('product-form-error').textContent = '';

  const preview = document.getElementById('image-preview');
  document.getElementById('variant-rows').innerHTML = '';

  if (product) {
    heading.textContent = `Edit: ${product.name}`;
    document.getElementById('product-id').value = product.productId;
    document.getElementById('product-name').value = product.name;
    document.getElementById('product-description').value = product.description || '';
    // Type first - it decides which categories are offered - then category.
    // listingTypeOf() recovers the type of a listing saved before the field
    // existed, so an old rental opens as a rental rather than as a product.
    const type = listingTypeOf(product);
    document.getElementById('product-listing-type').value = type;
    fillCategoryOptions(type);
    document.getElementById('product-category').value = categoryIdOf(product.category);
    document.getElementById('product-status').value = product.status || 'active';
    if (product.imageUrl) {
      preview.src = optimizedImageUrl(product.imageUrl, IMG_W.card);
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
    // Shown only for products that already have a second photo - there is no
    // way to add one any more.
    showPhoto2(product.imageUrl2);
    const activeVariants = product.variants.filter((v) => v.status === 'active');
    if (activeVariants.length === 0) addVariantRow();
    else activeVariants.forEach((v) => addVariantRow(v));
  } else {
    heading.textContent = 'Add Product';
    document.getElementById('product-id').value = '';
    document.getElementById('product-name').value = '';
    document.getElementById('product-description').value = '';
    document.getElementById('product-listing-type').value = '';
    fillCategoryOptions('');
    document.getElementById('product-category').value = '';
    document.getElementById('product-status').value = 'active';
    preview.classList.add('hidden');
    showPhoto2('');
    addVariantRow();
  }

  updateVarietyLabels();
  UnsavedGuard.watch(document.getElementById('product-form'), { skipWhenHidden: true });
  section.scrollIntoView({ behavior: 'smooth' });
}

function closeForm() {
  // Closing the panel is a decision, so stop watching rather than warn about
  // a form the vendor has deliberately put away.
  UnsavedGuard.release(document.getElementById('product-form'));
  document.getElementById('product-form-section').classList.add('hidden');
}

function addVariantRow(variant) {
  variantRowSeq++;
  const rowId = `variant-row-${variantRowSeq}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'variant-row';
  wrapper.dataset.variantId = variant ? variant.variantId : '';
  const listingType = document.getElementById('product-listing-type').value;
  const rowLabel = varietyRowLabelText(listingType);
  const rowPlaceholder = varietyRowPlaceholderText(listingType);
  wrapper.innerHTML = `
    <div class="field">
      <label for="${rowId}-label">${escapeHtml(rowLabel)}</label>
      <input id="${rowId}-label" class="variant-label" placeholder="${escapeAttr(rowPlaceholder)}" value="${escapeAttr(variant ? variant.label : '')}" required>
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

// Retitle the section and each already-added variety row for the currently
// selected listing type. Called on type change and after openForm builds the
// rows, so switching to Rental/Service after adding rows keeps every row in
// sync.
//
// The section heading is still written even though it is now visually hidden -
// it is what names this group of fields to a screen reader, and the visible
// "Variety"/"Price" column labels only describe one row each.
function updateVarietyLabels() {
  const listingType = document.getElementById('product-listing-type').value;
  document.getElementById('varieties-label').textContent = varietiesSectionText(listingType);
  const rowLabel = varietyRowLabelText(listingType);
  const rowPlaceholder = varietyRowPlaceholderText(listingType);
  document.querySelectorAll('#variant-rows .variant-row .variant-label').forEach((input) => {
    const label = input.closest('.field').querySelector('label');
    if (label) label.textContent = rowLabel;
    input.placeholder = rowPlaceholder;
  });
}

function onImageFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedImageFile = file;
  UnsavedGuard.markDirty(document.getElementById('product-form'));
  const preview = document.getElementById('image-preview');
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

/**
 * Shows the existing-second-photo block, or hides it. There is no way to ADD a
 * second photo any more, so this appears only for products that already have
 * one - which is also why it offers removal rather than replacement.
 */
function showPhoto2(url) {
  const field = document.getElementById('existing-photo2-field');
  const img = document.getElementById('image-preview-2');
  if (!field || !img) return;
  if (url) {
    img.src = optimizedImageUrl(url, IMG_W.card);
    field.classList.remove('hidden');
  } else {
    field.classList.add('hidden');
  }
}

/**
 * Marks the second photo for removal. Nothing is deleted until Save Product -
 * so Cancel still cancels, which is what a vendor will expect from a form.
 */
function onRemovePhoto2() {
  clearPhoto2 = true;
  showPhoto2('');
  UnsavedGuard.markDirty(document.getElementById('product-form'));
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

  // Category is required (the <select> has no default). Native validation
  // normally blocks submit, but guard here too since this handler runs after
  // preventDefault - and a legacy product with no stored category opens on the
  // empty placeholder, so an edit could otherwise reach this with a blank value.
  if (!document.getElementById('product-listing-type').value) {
    errorEl.textContent = 'Please choose what you are offering.';
    return;
  }
  if (!document.getElementById('product-category').value) {
    errorEl.textContent = 'Please choose a category.';
    return;
  }

  const variants = Array.from(document.querySelectorAll('#variant-rows .variant-row')).map((row) => ({
    variantId: row.dataset.variantId || undefined,
    label: row.querySelector('.variant-label').value.trim(),
    price: parseFloat(row.querySelector('.variant-price').value)
  }));

  if (variants.some((v) => !v.label || isNaN(v.price) || v.price < 0)) {
    // Name the field the way the form now names it - "fill in a label" points
    // at a word that is no longer on screen.
    const noun = varietyRowLabelText(document.getElementById('product-listing-type').value).toLowerCase();
    errorEl.textContent = `Please fill in a ${noun} and a valid price for every row.`;
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
    listingType: document.getElementById('product-listing-type').value,
    status: document.getElementById('product-status').value,
    variants
  };

  // Only sent when the vendor actually asked to clear it. updateProduct keeps
  // the existing value when imageUrl2 is undefined and clears it when the key
  // is present and empty, so sending it unconditionally would wipe every
  // second photo on the first edit of any product.
  if (clearPhoto2) payload.imageUrl2 = '';

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

  setSaveProductIdle(saveBtn);
  UnsavedGuard.markSaved(document.getElementById('product-form'));
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
