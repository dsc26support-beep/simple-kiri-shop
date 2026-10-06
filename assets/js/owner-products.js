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
 * & Hardware".
 *
 * Other is NO LONGER offered. It was the catch-all that meant nothing could be
 * unfileable, and it became the place things went instead of being filed;
 * there are seventeen categories now and every listing type has several. It
 * stays on the browse rail, so anything already sitting in it is still
 * reachable by a shopper.
 *
 * The one exception is a product that is ALREADY in Other. Dropping the option
 * out from under it would leave the picker empty on open and the save blocked
 * by the "choose a category" guard - so someone editing that listing's price
 * would be forced to re-file it first. It is offered back to them, marked, and
 * disappears the moment they pick anything else.
 *
 * Keeps the current selection if it survives the narrowing - changing type
 * should not silently clear a category the seller already picked.
 */
function onListingTypeChange() {
  const type = document.getElementById('product-listing-type').value;
  fillCategoryOptions(type, document.getElementById('product-category').value);
  updateVarietyLabels();
}

function fillCategoryOptions(listingType, keepId) {
  const select = document.getElementById('product-category');
  const previous = select.value;
  const list = activeCategories().filter(
    (c) => (c.id === 'other' ? keepId === 'other' : (!listingType || c.types.indexOf(listingType) !== -1))
  );
  select.innerHTML = '<option value="" disabled' + (previous ? '' : ' selected') + '>Choose a category…</option>' +
    list.map((c) => {
      const label = c.id === 'other' ? c.label + ' (please re-file)' : c.label;
      return `<option value="${escapeHtml(c.id)}">${escapeHtml(label)}</option>`;
    }).join('');
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
  document.getElementById('add-variant-btn').addEventListener('click', () => { clearFieldErrors(); addVariantRow(); });
  document.getElementById('product-listing-type').addEventListener('change', onListingTypeChange);
  document.getElementById('product-form').addEventListener('submit', onSaveProduct);
  document.getElementById('product-form').addEventListener('input', onFieldEdited);
  document.getElementById('product-description').addEventListener('input', updateDescriptionCount);
  document.getElementById('product-form').addEventListener('change', onFieldEdited);
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
            <button type="button" class="btn btn-small" data-action="duplicate">Duplicate</button>
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
  } else if (e.target.closest('[data-action="duplicate"]')) {
    openForm(product, { duplicate: true });
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

/**
 * opts.duplicate: start a NEW listing pre-filled from `product` - same text,
 * type, category, status and varieties (price and stock included), but no
 * product id and no variant ids, so Save creates rather than edits.
 *
 * The photo is deliberately NOT copied. Photos aren't reference-counted:
 * replacing a product's photo deletes the old file (actionUploadProductImage
 * in Images.gs), so a copy sharing the original's photo would go blank the
 * day the original's photo is changed.
 */
function openForm(product, opts) {
  const duplicate = !!(product && opts && opts.duplicate);
  const section = document.getElementById('product-form-section');
  const heading = document.getElementById('product-form-heading');
  section.classList.remove('hidden');
  selectedImageFile = null;
  clearPhoto2 = false;
  document.getElementById('product-image-input').value = '';
  document.getElementById('product-form-error').textContent = '';
  clearFieldErrors();

  const preview = document.getElementById('image-preview');
  document.getElementById('variant-rows').innerHTML = '';

  document.getElementById('duplicate-photo-note').hidden = !duplicate;

  if (product) {
    heading.textContent = duplicate ? `Duplicate: ${product.name}` : `Edit: ${product.name}`;
    document.getElementById('product-id').value = duplicate ? '' : product.productId;
    document.getElementById('product-name').value = duplicate ? `${product.name} (copy)` : product.name;
    document.getElementById('product-description').value = product.description || '';
    // Type first - it decides which categories are offered - then category.
    // listingTypeOf() recovers the type of a listing saved before the field
    // existed, so an old rental opens as a rental rather than as a product.
    const type = listingTypeOf(product);
    const existing = categoryIdOf(product.category);
    document.getElementById('product-listing-type').value = type;
    // A duplicate is a new listing, and new listings never get "Other" - an
    // old product still filed there makes the seller choose a real one.
    fillCategoryOptions(type, duplicate ? '' : existing);
    document.getElementById('product-category').value = existing;
    document.getElementById('product-status').value = product.status || 'active';
    if (product.imageUrl && !duplicate) {
      preview.src = optimizedImageUrl(product.imageUrl, IMG_W.card);
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
    // Shown only for products that already have a second photo - there is no
    // way to add one any more.
    showPhoto2(duplicate ? '' : product.imageUrl2);
    const activeVariants = product.variants.filter((v) => v.status === 'active');
    if (activeVariants.length === 0) addVariantRow();
    else activeVariants.forEach((v) => addVariantRow(duplicate ? Object.assign({}, v, { variantId: '' }) : v));
  } else {
    heading.textContent = 'Add Product';
    document.getElementById('product-id').value = '';
    document.getElementById('product-name').value = '';
    document.getElementById('product-description').value = '';
    document.getElementById('product-listing-type').value = '';
    fillCategoryOptions('', '');   // a new listing never gets Other
    document.getElementById('product-category').value = '';
    document.getElementById('product-status').value = 'active';
    preview.classList.add('hidden');
    showPhoto2('');
    addVariantRow();
  }

  updateVarietyLabels();
  updateDescriptionCount();
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
      <label for="${rowId}-label" class="is-required">${escapeHtml(rowLabel)}</label>
      <input id="${rowId}-label" class="variant-label" placeholder="${escapeAttr(rowPlaceholder)}" value="${escapeAttr(variant ? variant.label : '')}" required>
    </div>
    <div class="field">
      <label for="${rowId}-price" class="is-required">Price</label>
      <input id="${rowId}-price" class="variant-price" type="number" min="0.01" step="0.01" value="${variant ? variant.price : ''}" required>
    </div>
    <div class="field">
      <label for="${rowId}-stock">Stock (blank = unlimited)</label>
      <input id="${rowId}-stock" class="variant-stock" type="number" min="0" step="1" placeholder="Unlimited" value="${variant && variant.stockQty !== '' && variant.stockQty != null ? variant.stockQty : ''}">
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

// Must match capLength(..., 2000/150) in Products.gs, which counts the same
// trimmed .length this form sends.
const DESCRIPTION_MAX = 2000;
const DESCRIPTION_WARN_AT = 1800;
const NAME_MAX = 150;

function updateDescriptionCount() {
  const n = document.getElementById('product-description').value.trim().length;
  const out = document.getElementById('description-count');
  out.hidden = n < DESCRIPTION_WARN_AT;
  out.classList.toggle('is-over', n > DESCRIPTION_MAX);
  out.textContent = n > DESCRIPTION_MAX
    ? `${(n - DESCRIPTION_MAX).toLocaleString()} characters over the ${DESCRIPTION_MAX.toLocaleString()} limit - shorten it to save.`
    : `${(DESCRIPTION_MAX - n).toLocaleString()} characters left`;
}

let fieldErrorSeq = 0;

function clearFieldErrors() {
  const form = document.getElementById('product-form');
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
}

/**
 * The message goes directly under the field it is about, and focus moves there,
 * instead of into the one alert at the bottom of a long form - on a phone that
 * alert was a screen away from whatever needed fixing. Only one at a time, the
 * topmost problem, so fixing them goes in reading order.
 */
function showFieldError(control, message, existingMsg) {
  clearFieldErrors();
  // existingMsg: a message already on screen that says it (the description
  // counter), so the error points at that rather than repeating it in red.
  let msg = existingMsg;
  if (!msg) {
    msg = document.createElement('p');
    msg.className = 'field-error';
    msg.id = `field-error-${++fieldErrorSeq}`;
    msg.textContent = message;
    // In a variety row each field is a narrow flex column; across the whole row
    // the message reads as one line, and the outline still marks which input.
    const row = control.closest('.variant-row');
    if (row) row.appendChild(msg);
    else control.insertAdjacentElement('afterend', msg);
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) {
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', msg.id);
  }
  control.focus({ preventScroll: true });
  control.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function onFieldEdited(e) {
  if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true') clearFieldErrors();
}

/**
 * Top to bottom, so the first error is also the first thing on the page. The
 * form is novalidate: native bubbles looked different on every phone and
 * vanished on scroll, and could only ever cover "empty", not "price of 0".
 * Returns false (with the error shown) or the variants to send.
 */
function validateProductForm() {
  const name = document.getElementById('product-name');
  if (!name.value.trim()) {
    showFieldError(name, 'Please enter a name for this listing.');
    return false;
  }
  if (name.value.trim().length > NAME_MAX) {
    showFieldError(name, `Keep the name to ${NAME_MAX} characters or fewer.`);
    return false;
  }
  const description = document.getElementById('product-description');
  if (description.value.trim().length > DESCRIPTION_MAX) {
    showFieldError(description, null, document.getElementById('description-count'));
    return false;
  }
  const type = document.getElementById('product-listing-type');
  if (!type.value) {
    showFieldError(type, 'Please choose what you are offering.');
    return false;
  }
  // A legacy product with no stored category opens on the empty placeholder,
  // so an edit can reach this with a blank value too.
  const category = document.getElementById('product-category');
  if (!category.value) {
    showFieldError(category, 'Please choose a category.');
    return false;
  }

  const rows = Array.from(document.querySelectorAll('#variant-rows .variant-row'));
  if (rows.length === 0) {
    showFieldError(document.getElementById('add-variant-btn'), 'Add at least one variety (e.g. a size or pack) with a price.');
    return false;
  }
  // Name the field the way the form now names it - "fill in a label" points
  // at a word that is no longer on screen.
  const noun = varietyRowLabelText(type.value).toLowerCase();
  const variants = [];
  for (const row of rows) {
    const labelInput = row.querySelector('.variant-label');
    const priceInput = row.querySelector('.variant-price');
    const stockInput = row.querySelector('.variant-stock');
    const label = labelInput.value.trim();
    const price = parseFloat(priceInput.value);
    const stockRaw = stockInput.value.trim();
    if (!label) {
      showFieldError(labelInput, `Please fill in a ${noun}.`);
      return false;
    }
    if (isNaN(price) || price <= 0) {
      showFieldError(priceInput, 'Enter a price greater than zero.');
      return false;
    }
    if (stockRaw !== '' && !/^\d+$/.test(stockRaw)) {
      showFieldError(stockInput, 'Leave blank for unlimited, or enter a whole number (0 or more).');
      return false;
    }
    variants.push({
      variantId: row.dataset.variantId || undefined,
      label,
      price,
      stockQty: stockRaw === '' ? '' : parseInt(stockRaw, 10)
    });
  }
  return variants;
}

async function onSaveProduct(e) {
  e.preventDefault();
  const errorEl = document.getElementById('product-form-error');
  errorEl.textContent = '';

  const variants = validateProductForm();
  if (!variants) return;

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

  // Set as soon as the product itself exists, win or lose on the photo below -
  // a retry (clicking Save Product again without reopening the form) must go
  // through updateProduct against this id, never createProduct a second time.
  document.getElementById('product-id').value = res.productId;

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
  const reloadOpts = productId ? undefined : { limit: productsTotal + 1 };

  if (selectedImageFile) {
    setSaveProductBusy(saveBtn, 'Uploading photo 1');
    let uploadOk = false;
    try {
      const { base64, mimeType } = await compressImage(selectedImageFile);
      const uploadRes = await Api.post('uploadProductImage', {
        token: Auth.getToken(),
        productId: res.productId,
        imageBase64: base64,
        mimeType,
        slot: 1
      });
      uploadOk = uploadRes.ok;
      if (!uploadOk) {
        errorEl.textContent = `Product saved, but photo 1 upload failed: ${uploadRes.error || 'unknown error'}. Click Save Product to try the photo again.`;
      }
    } catch (err) {
      errorEl.textContent = 'Product saved, but photo 1 could not be processed. Click Save Product to try the photo again.';
    }
    if (!uploadOk) {
      // Left open on purpose: closing here would hide #product-form-error,
      // the very element the message above was just written into, before the
      // vendor could ever read it.
      setSaveProductIdle(saveBtn);
      await loadProducts(reloadOpts);
      return;
    }
  }

  setSaveProductIdle(saveBtn);
  UnsavedGuard.markSaved(document.getElementById('product-form'));
  closeForm();
  await loadProducts(reloadOpts);
}
