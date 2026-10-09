// Seller product form: Single product / Product with options, the options
// editor, the combinations grid and photos per option (owner/products.html).
//
// The rules (validation, combinations, what a save will change) are
// product-options.js - a generated copy of apps-script/ProductOptions.gs - so
// what this form allows is what the backend accepts. The backend checks it all
// again on Save and owns every id, price and stock number.
//
// Sellers never see ids or JSON: they add option types (Colour, Size, or any
// name), type the values, press "Make the combinations", switch off the ones
// they don't sell, and fill in price / stock / SKU / photos per row.
const ProductOptionsEditor = (() => {
  const $ = (id) => document.getElementById(id);
  let mode = 'list';           // 'single' | 'options' | 'list'
  let options = [];            // [{ id, name, kind, values: [{ id, label, hex? }] }]
  let rows = new Map();        // combination key -> row
  let single = null;           // the one row of a single product
  let loaded = null;           // the product as opened (null = new)
  let photoMax = 4;

  const rid = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
  const keyOf = (values) => (options.length ? optionComboKey(values, options) : '');

  function blankRow(values) {
    return { variantId: '', values: values || {}, active: true, price: '', stockQty: '', sku: '', images: [], pending: [] };
  }

  /* ---------- mode ---------- */

  function setListingType(listingType) {
    const isProduct = !listingType || listingType === 'product';
    $('product-type-field').hidden = !isProduct;
    if (!isProduct) setMode('list');
    // Back to a product from a rental/service: a new listing starts as Single.
    // An older product listing keeps its list until the seller converts it.
    else if (mode === 'list' && !(loaded && !loaded.productType && listingTypeOf(loaded) === 'product')) setMode('single');
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('input[name="productType"]').forEach((r) => { r.checked = r.value === next; });
    $('single-fields').hidden = next !== 'single';
    $('options-editor').hidden = next !== 'options';
    $('varieties-block').hidden = next !== 'list';
    if (next === 'options' && !options.length) {
      // A fresh product with options starts with nothing chosen - the seller picks
      // Colour, Size, both, or their own. Converting an older listing (explicit
      // choice) offers its varieties as the values of one option instead.
      const legacy = legacyVarieties();
      if (legacy.length) {
        const opt = { id: rid('o'), name: 'Option', kind: 'custom', values: legacy.map((v) => ({ id: rid('v'), label: v.label.slice(0, 30) })) };
        options = [opt];
        legacy.forEach((v, i) => {
          const values = { [opt.id]: opt.values[i].id };
          rows.set(optionComboKey(values, options), Object.assign(blankRow(values), { variantId: v.variantId, price: v.price, stockQty: v.stockQty === '' ? '' : v.stockQty, sku: v.sku || '' }));
        });
        setStatus('Your varieties became the values of one option called "Option". Rename it (e.g. Size) and check the rows below.');
      }
    }
    if (next === 'single' && !single) {
      const legacy = legacyVarieties();
      single = blankRow({});
      if (legacy.length) Object.assign(single, { variantId: legacy[0].variantId, price: legacy[0].price, stockQty: legacy[0].stockQty, sku: legacy[0].sku || '' });
      fillSingle();
    }
    render();
  }

  function legacyVarieties() {
    if (!loaded || loaded.productType) return [];
    return (loaded.variants || []).filter((v) => v.status === 'active');
  }

  /* ---------- load / reset ---------- */

  function load(product, opts) {
    loaded = product && !(opts && opts.duplicate) ? product : null;
    options = [];
    rows = new Map();
    single = null;
    setStatus('');
    const listingType = product ? listingTypeOf(product) : '';
    if (product && product.productType === 'options') {
      options = JSON.parse(JSON.stringify(product.options || []));
      if (opts && opts.duplicate) options.forEach((o) => { o.id = rid('o'); o.values.forEach((v) => { v.id = rid('v'); }); });
      (product.variants || []).filter((v) => v.status !== 'deleted').forEach((v) => {
        let values = v.values || {};
        if (opts && opts.duplicate) values = remapValues(product.options, options, values);
        const key = optionComboKey(values, options);
        if (!key) return;
        rows.set(key, Object.assign(blankRow(values), { variantId: opts && opts.duplicate ? '' : v.variantId, active: v.status === 'active',
          price: v.price, stockQty: v.stockQty === '' || v.stockQty == null ? '' : v.stockQty, sku: v.sku || '', images: opts && opts.duplicate ? [] : (v.images || []) }));
      });
      mode = 'options';
    } else if (product && product.productType === 'single') {
      const v = (product.variants || []).filter((x) => x.status === 'active')[0] || product.variants[0] || {};
      single = Object.assign(blankRow({}), { variantId: opts && opts.duplicate ? '' : v.variantId, price: v.price, stockQty: v.stockQty === '' || v.stockQty == null ? '' : v.stockQty,
        sku: v.sku || '', images: opts && opts.duplicate ? [] : (v.images || []) });
      mode = 'single';
    } else if (product) {
      mode = 'list';           // an older listing stays a list until the seller converts it
    } else {
      mode = 'single';
    }
    $('ptype-list-label').hidden = !(product && !product.productType && listingType === 'product');
    $('product-type-field').hidden = !(listingType === 'product' || !listingType);
    if (listingType && listingType !== 'product') mode = 'list';
    fillSingle();
    setMode(mode);
  }

  function remapValues(fromOpts, toOpts, values) {
    const out = {};
    fromOpts.forEach((o, i) => {
      const j = o.values.findIndex((v) => v.id === values[o.id]);
      if (j !== -1) out[toOpts[i].id] = toOpts[i].values[j].id;
    });
    return out;
  }

  function fillSingle() {
    const s = single || blankRow({});
    $('single-price').value = s.price === '' || s.price == null ? '' : s.price;
    $('single-stock').value = s.stockQty === '' || s.stockQty == null ? '' : s.stockQty;
    $('single-sku').value = s.sku || '';
  }

  /* ---------- options editor ---------- */

  function addOption(kind) {
    if (options.length >= PRODUCT_OPTION_LIMITS.types) { setStatus(`Use at most ${PRODUCT_OPTION_LIMITS.types} options.`); return; }
    const name = kind === 'colour' ? 'Colour' : kind === 'size' ? 'Size' : '';
    if (name && options.some((o) => o.name.toLowerCase() === name.toLowerCase())) { setStatus(`${name} is already added.`); return; }
    options.push({ id: rid('o'), name, kind, values: [] });
    render();
    const inputs = document.querySelectorAll('#option-types .option-type');
    const last = inputs[inputs.length - 1];
    if (last) (name ? last.querySelector('.ov-new') : last.querySelector('.ot-name')).focus();
  }

  function optionCardHtml(o, i) {
    const values = o.values.map((v, j) => `
      <li class="ov" data-v="${j}">
        ${o.kind === 'colour' ? `<input type="color" class="ov-hex" value="${escapeHtml(v.hex || '#cccccc')}" aria-label="Colour of ${escapeHtml(v.label)}">` : ''}
        <input class="ov-label" value="${escapeHtml(v.label)}" maxlength="30" aria-label="${escapeHtml(o.name || 'Option')} value ${j + 1}">
        <button type="button" class="btn btn-small ov-remove" aria-label="Remove ${escapeHtml(v.label)}">×</button>
      </li>`).join('');
    return `<fieldset class="option-type" data-o="${i}">
      <legend class="sr-only">Option ${i + 1}</legend>
      <div class="ot-head">
        <label class="sr-only" for="ot-name-${i}">Option name</label>
        <input id="ot-name-${i}" class="ot-name" value="${escapeHtml(o.name)}" maxlength="30" placeholder="Option name, e.g. Material">
        <button type="button" class="btn btn-small ot-up" aria-label="Move ${escapeHtml(o.name || 'option')} up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn btn-small btn-danger ot-remove">Remove</button>
      </div>
      <ul class="ov-list">${values}</ul>
      <div class="ov-add">
        <label class="sr-only" for="ov-new-${i}">Add a value to ${escapeHtml(o.name || 'this option')}</label>
        <input id="ov-new-${i}" class="ov-new" maxlength="30" placeholder="${o.kind === 'colour' ? 'e.g. Red' : o.kind === 'size' ? 'e.g. M' : 'e.g. Cotton'}">
        <button type="button" class="btn btn-small ov-add-btn">Add</button>
      </div>
    </fieldset>`;
  }

  function onOptionsInput(e) {
    const card = e.target.closest('.option-type');
    if (!card) return;
    const o = options[Number(card.dataset.o)];
    if (e.target.classList.contains('ot-name')) o.name = e.target.value;
    const li = e.target.closest('.ov');
    if (li) {
      const v = o.values[Number(li.dataset.v)];
      if (e.target.classList.contains('ov-label')) v.label = e.target.value;
      if (e.target.classList.contains('ov-hex')) v.hex = e.target.value;
      renderGridLabels();
    }
  }

  function onOptionsClick(e) {
    const card = e.target.closest('.option-type');
    if (!card) return;
    const i = Number(card.dataset.o);
    const o = options[i];
    if (e.target.closest('.ot-remove')) {
      if (o.values.length && !confirm(`Remove the option "${o.name || 'unnamed'}"? Combinations will need making again.`)) return;
      options.splice(i, 1);
      render();
    } else if (e.target.closest('.ot-up') && i > 0) {
      options.splice(i - 1, 0, options.splice(i, 1)[0]);
      render();
    } else if (e.target.closest('.ov-remove')) {
      o.values.splice(Number(e.target.closest('.ov').dataset.v), 1);
      render();
    } else if (e.target.closest('.ov-add-btn')) {
      addValue(card, o);
    }
  }

  function addValue(card, o) {
    const input = card.querySelector('.ov-new');
    const label = input.value.replace(/\s+/g, ' ').trim();
    if (!label) return;
    if (o.values.some((v) => v.label.toLowerCase() === label.toLowerCase())) { setStatus(`"${label}" is already there.`); return; }
    if (o.values.length >= PRODUCT_OPTION_LIMITS.values) { setStatus(`At most ${PRODUCT_OPTION_LIMITS.values} values per option.`); return; }
    o.values.push(Object.assign({ id: rid('v'), label }, o.kind === 'colour' ? { hex: guessHex(label) } : {}));
    render();
    const again = document.querySelector(`#option-types .option-type[data-o="${card.dataset.o}"] .ov-new`);
    if (again) again.focus();
  }

  const COMMON_COLOURS = { red: '#c62828', blue: '#1565c0', green: '#2e7d32', black: '#111111', white: '#ffffff', yellow: '#f9a825', pink: '#ec407a',
    purple: '#6a1b9a', orange: '#ef6c00', brown: '#6d4c41', grey: '#9e9e9e', gray: '#9e9e9e', navy: '#1a237e', gold: '#c9a227', silver: '#c0c0c0', beige: '#d7c9a7' };
  function guessHex(label) { return COMMON_COLOURS[label.toLowerCase()] || '#cccccc'; }

  /* ---------- combinations ---------- */

  function generate() {
    const checked = validateProductOptions(options, PRODUCT_OPTION_LIMITS);
    if (!checked.ok) { setStatus(checked.error); return; }
    const next = new Map();
    const fallback = { price: $('bulk-price').value, stockQty: $('bulk-stock').value };
    generateOptionCombinations(options).forEach((values) => {
      const key = optionComboKey(values, options);
      next.set(key, rows.get(key) || Object.assign(blankRow(values), { price: fallback.price, stockQty: fallback.stockQty }));
    });
    const dropped = Array.from(rows.keys()).filter((k) => !next.has(k) && rows.get(k).variantId).length;
    rows = next;
    renderGrid();
    setStatus(`${rows.size} combination(s).${dropped ? ` ${dropped} that no longer exist will be switched off when you save (kept, not deleted).` : ''} Switch off any you don't sell.`);
  }

  function renderGridLabels() {
    document.querySelectorAll('#variant-grid .vg-row').forEach((tr) => {
      const r = rows.get(tr.dataset.key);
      if (r) tr.querySelector('.vg-label').textContent = optionComboLabel(r.values, options);
    });
  }

  function renderGrid() {
    const filter = ($('vg-filter').value || '').toLowerCase();
    const list = Array.from(rows.entries());
    $('variant-grid').innerHTML = list.length ? `<table class="vg-table">
      <thead><tr><th scope="col"><span class="sr-only">On sale</span><input type="checkbox" id="vg-all" aria-label="Select all for bulk changes"></th><th scope="col">Combination</th><th scope="col">Price</th><th scope="col">Stock</th><th scope="col">SKU</th><th scope="col">Photos</th></tr></thead>
      <tbody>${list.map(([key, r], i) => {
        const label = optionComboLabel(r.values, options);
        const hide = filter && label.toLowerCase().indexOf(filter) === -1;
        return `<tr class="vg-row${r.active ? '' : ' is-off'}" data-key="${escapeHtml(key)}"${hide ? ' hidden' : ''}>
          <td><input type="checkbox" class="vg-pick" aria-label="Select ${escapeHtml(label)} for bulk changes"></td>
          <td><label class="vg-on"><input type="checkbox" class="vg-active"${r.active ? ' checked' : ''}> <span class="vg-label">${escapeHtml(label)}</span></label>${r.active ? '' : ' <span class="helper-text">not sold</span>'}</td>
          <td><input class="vg-price" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(String(r.price ?? ''))}" aria-label="Price of ${escapeHtml(label)}"></td>
          <td><input class="vg-stock" type="number" min="0" step="1" inputmode="numeric" placeholder="∞" value="${escapeHtml(String(r.stockQty ?? ''))}" aria-label="Stock of ${escapeHtml(label)} (blank = unlimited)"></td>
          <td><input class="vg-sku" maxlength="60" value="${escapeHtml(r.sku || '')}" aria-label="SKU of ${escapeHtml(label)}"></td>
          <td><button type="button" class="btn btn-small vg-photos" aria-expanded="false">${r.images.length + r.pending.length || 'Add'}</button></td>
        </tr>`;
      }).join('')}</tbody></table>` : '<p class="helper-text">Add options and values above, then press <strong>Make the combinations</strong>.</p>';
  }

  function onGridInput(e) {
    const tr = e.target.closest('.vg-row');
    if (!tr) return;
    const r = rows.get(tr.dataset.key);
    if (e.target.classList.contains('vg-price')) r.price = e.target.value;
    if (e.target.classList.contains('vg-stock')) r.stockQty = e.target.value;
    if (e.target.classList.contains('vg-sku')) r.sku = e.target.value;
    if (e.target.classList.contains('vg-active')) {
      r.active = e.target.checked;
      tr.classList.toggle('is-off', !r.active);
    }
  }

  function onGridClick(e) {
    if (e.target.id === 'vg-all') {
      document.querySelectorAll('#variant-grid .vg-row:not([hidden]) .vg-pick').forEach((c) => { c.checked = e.target.checked; });
      return;
    }
    const btn = e.target.closest('.vg-photos');
    if (btn) {
      const tr = btn.closest('.vg-row');
      togglePhotos(tr, rows.get(tr.dataset.key), btn);
    }
  }

  /** Bulk change - only for the rows the seller ticked, and only after they confirm. */
  function applyBulk() {
    const picked = Array.from(document.querySelectorAll('#variant-grid .vg-pick:checked')).map((c) => c.closest('.vg-row').dataset.key);
    const price = $('bulk-price').value.trim();
    const stock = $('bulk-stock').value.trim();
    if (!picked.length) { setStatus('Tick the rows to change first.'); return; }
    if (!price && !stock) { setStatus('Enter a price or stock to apply.'); return; }
    const labels = picked.map((k) => optionComboLabel(rows.get(k).values, options));
    const what = [price ? `price ${price}` : '', stock ? `stock ${stock}` : ''].filter(Boolean).join(' and ');
    if (!confirm(`Set ${what} for these ${picked.length}:\n${labels.join(', ')}?`)) return;
    picked.forEach((k) => { const r = rows.get(k); if (price) r.price = price; if (stock) r.stockQty = stock; });
    renderGrid();
    setStatus(`Updated ${picked.length} combination(s). Not saved yet.`);
  }

  /* ---------- photos per combination ---------- */

  function togglePhotos(tr, r, btn) {
    const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains('vg-photo-row');
    document.querySelectorAll('#variant-grid .vg-photo-row').forEach((x) => x.remove());
    document.querySelectorAll('#variant-grid .vg-photos').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (open) return;
    btn.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('tr');
    panel.className = 'vg-photo-row';
    panel.innerHTML = '<td colspan="6"></td>';
    tr.after(panel);
    drawPhotoPanel(panel.querySelector('td'), r, optionComboLabel(r.values, options), () => { btn.textContent = r.images.length + r.pending.length || 'Add'; });
  }

  function photoPanelHtml(r, label) {
    const saved = r.images.map((im, i) => `<li class="vp" data-id="${escapeHtml(im.id)}">
        <img src="${escapeHtml(optimizedImageUrl(im.url, IMG_W.thumb))}" alt="${escapeHtml(label)} photo ${i + 1}" loading="lazy">
        ${i === 0 ? '<span class="vp-main">Main</span>' : `<button type="button" class="btn btn-small vp-first">Make main</button>`}
        <button type="button" class="btn btn-small btn-danger vp-remove">Remove</button>
      </li>`).join('');
    const pending = r.pending.map((f, i) => `<li class="vp vp--pending" data-pending="${i}"><span>${escapeHtml(f.name)}</span> <span class="helper-text">uploads when you save</span>
        <button type="button" class="btn btn-small btn-danger vp-drop">Remove</button></li>`).join('');
    return `<div class="vp-panel"><p class="helper-text">Photos of <strong>${escapeHtml(label)}</strong> - the first is the main one. Up to ${photoMax}.</p>
      <ul class="vp-list">${saved}${pending}</ul>
      <label class="btn btn-small vp-add">Add photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple class="vp-input" hidden></label>
      <p class="vp-msg form-error" role="alert"></p></div>`;
  }

  /** Draws a photo panel into host and wires it; redraws itself after each change. */
  function drawPhotoPanel(host, r, label, onCount) {
    host.innerHTML = photoPanelHtml(r, label);
    const panel = host;
    const redraw = () => { drawPhotoPanel(host, r, label, onCount); onCount(); };
    const msg = panel.querySelector('.vp-msg');
    panel.querySelector('.vp-input').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      const room = photoMax - r.images.length - r.pending.length;
      if (files.length > room) msg.textContent = `Only ${Math.max(0, room)} more photo(s) fit.`;
      const take = files.slice(0, Math.max(0, room)).filter((f) => {
        if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { msg.textContent = 'Use JPEG, PNG or WebP photos.'; return false; }
        return true;
      });
      if (!take.length) return;
      if (r.variantId) {
        for (const f of take) {
          const res = await uploadOne(r, f);
          if (!res.ok) { msg.textContent = res.error || 'That photo did not upload. Try again.'; break; }
        }
      } else {
        r.pending.push(...take);
      }
      markDirty();
      redraw();
    });
    panel.querySelectorAll('.vp-drop').forEach((b) => b.addEventListener('click', () => {
      r.pending.splice(Number(b.closest('.vp').dataset.pending), 1);
      redraw();
    }));
    panel.querySelectorAll('.vp-first, .vp-remove').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('.vp').dataset.id;
      const remove = b.classList.contains('vp-remove');
      if (remove && !confirm('Remove this photo? It is deleted straight away.')) return;
      const order = remove ? r.images.map((i) => i.id).filter((x) => x !== id) : [id].concat(r.images.map((i) => i.id).filter((x) => x !== id));
      b.disabled = true;
      const res = await Api.post('setVariantImages', { token: Auth.getToken(), productId: $('product-id').value, variantId: r.variantId, order });
      if (!res.ok) { b.disabled = false; msg.textContent = res.error || 'Could not change the photos.'; return; }
      r.images = res.images;
      redraw();
    }));
  }

  async function uploadOne(r, file) {
    let data;
    try { data = await compressImage(file); } catch (e) { return { ok: false, error: `${file.name} could not be read as a photo.` }; }
    const res = await Api.post('uploadVariantImage', { token: Auth.getToken(), productId: $('product-id').value, variantId: r.variantId,
      imageBase64: data.base64, mimeType: data.mimeType });
    if (res.ok) r.images = res.images;
    return res;
  }

  /** After a save: photos chosen before the combination existed are uploaded now. */
  async function uploadPending(res) {
    const all = mode === 'single' ? (single ? [single] : []) : Array.from(rows.values());
    if (mode === 'single' && single && res.variants && res.variants[0]) single.variantId = res.variants[0].variantId;
    if (mode === 'options' && res.variants) {
      res.variants.forEach((sv) => { const r = rows.get(sv.key); if (r) r.variantId = sv.variantId; });
    }
    const failures = [];
    for (const r of all) {
      while (r.pending.length && r.variantId) {
        const f = r.pending[0];
        const up = await uploadOne(r, f);
        if (!up.ok) { failures.push(f.name + ': ' + (up.error || 'failed')); break; }
        r.pending.shift();
      }
    }
    return failures;
  }

  /* ---------- save ---------- */

  /** { productType, options?, variants } for the save, or { error }. */
  function payload() {
    if (mode === 'list') return { productType: 'list' };
    if (mode === 'single') {
      single = single || blankRow({});
      single.price = $('single-price').value;
      single.stockQty = $('single-stock').value;
      single.sku = $('single-sku').value.trim();
      const price = Number(single.price);
      if (single.price === '' || !(price > 0)) return { error: 'Enter a price greater than zero.', focus: 'single-price' };
      if (single.stockQty !== '' && !/^\d+$/.test(String(single.stockQty))) return { error: 'Stock is a whole number, 0 or more (blank = unlimited).', focus: 'single-stock' };
      return { productType: 'single', variants: [{ variantId: single.variantId || undefined, price, stockQty: single.stockQty === '' ? '' : Number(single.stockQty), sku: single.sku }] };
    }
    const checked = validateProductOptions(options, PRODUCT_OPTION_LIMITS);
    if (!checked.ok) return { error: checked.error };
    if (!rows.size) return { error: 'Press "Make the combinations" first.' };
    const list = [];
    for (const r of rows.values()) {
      const key = optionComboKey(r.values, options);
      if (!key) return { error: 'The options changed - press "Make the combinations" again.' };
      const label = optionComboLabel(r.values, options);
      if (r.active && !(Number(r.price) > 0)) return { error: `Enter a price above 0 for ${label} (or switch it off).` };
      if (String(r.stockQty) !== '' && !/^\d+$/.test(String(r.stockQty))) return { error: `Stock for ${label} must be a whole number, 0 or more (blank = unlimited).` };
      list.push({ variantId: r.variantId || undefined, values: r.values, active: r.active, price: r.price === '' ? '' : Number(r.price),
        stockQty: String(r.stockQty) === '' ? '' : Number(r.stockQty), sku: String(r.sku || '').trim() });
    }
    if (!list.some((r) => r.active)) return { error: 'Switch on at least one combination you sell.' };
    return { productType: 'options', options: checked.options, variants: list };
  }

  /**
   * What a save will do to an existing product's variants, in words - shown
   * for confirmation when it creates or switches off anything.
   */
  function changeSummary(p) {
    if (!loaded || p.productType !== 'options') return '';
    const existing = (loaded.variants || []).map((v) => ({ variantId: v.variantId, values: v.values || {}, status: v.status, label: v.label }));
    const plan = planVariantChanges(p.options, existing, p.variants);
    if (!plan.ok) return '';
    const created = plan.rows.filter((r) => r.action === 'create').map((r) => r.label);
    const off = plan.rows.filter((r) => r.action === 'disable' && (loaded.variants || []).some((v) => v.variantId === r.variantId && v.status === 'active')).map((r) => r.label)
      .concat(plan.disabled.map((d) => d.label));
    if (!created.length && !off.length) return '';
    return [created.length ? `${created.length} new: ${created.slice(0, 8).join(', ')}${created.length > 8 ? '…' : ''}` : '',
      off.length ? `${off.length} switched off (kept with their stock history, not deleted): ${off.slice(0, 8).join(', ')}${off.length > 8 ? '…' : ''}` : '',
      `${plan.rows.filter((r) => r.action === 'update').length} kept as they are.`].filter(Boolean).join('\n');
  }

  /** Words for the listing checks' detail rule (volume, size...). */
  function labels() {
    if (mode !== 'options') return [];
    return options.reduce((all, o) => all.concat(o.values.map((v) => v.label)), []);
  }

  /** A preview of the shopper's card, from what is in the form now. */
  function previewProduct(base) {
    const p = Object.assign({}, base, { productType: mode === 'list' ? undefined : mode, options: mode === 'options' ? options : undefined });
    if (mode === 'single') p.variants = [{ variantId: 'preview', label: 'Standard', price: Number($('single-price').value) || 0, stockQty: $('single-stock').value === '' ? null : Number($('single-stock').value), images: (single ? single.images : []).map((i) => i.url) }];
    if (mode === 'options') {
      p.variants = Array.from(rows.values()).filter((r) => r.active).map((r, i) => ({ variantId: 'pv' + i, label: optionComboLabel(r.values, options), values: r.values,
        price: Number(r.price) || 0, stockQty: String(r.stockQty) === '' ? null : Number(r.stockQty), images: r.images.map((im) => im.url) }));
    }
    return p;
  }

  function setStatus(text) { $('options-status').textContent = text || ''; }
  function markDirty() { if (typeof UnsavedGuard !== 'undefined') UnsavedGuard.markDirty($('product-form')); }

  function render() {
    $('option-types').innerHTML = options.map(optionCardHtml).join('');
    const sp = $('single-photos');
    if (sp) {
      sp.innerHTML = '';
      if (mode === 'single') {
        single = single || blankRow({});
        drawPhotoPanel(sp, single, 'this product', () => {});
      }
    }
    renderGrid();
  }

  function init() {
    document.querySelectorAll('input[name="productType"]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
    $('add-colour-btn').addEventListener('click', () => addOption('colour'));
    $('add-size-btn').addEventListener('click', () => addOption('size'));
    $('add-option-btn').addEventListener('click', () => addOption('custom'));
    $('option-types').addEventListener('input', onOptionsInput);
    $('option-types').addEventListener('click', onOptionsClick);
    $('option-types').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('ov-new')) { e.preventDefault(); addValue(e.target.closest('.option-type'), options[Number(e.target.closest('.option-type').dataset.o)]); }
    });
    $('generate-variants-btn').addEventListener('click', generate);
    $('variant-grid').addEventListener('input', onGridInput);
    $('variant-grid').addEventListener('change', onGridInput);
    $('variant-grid').addEventListener('click', onGridClick);
    $('bulk-apply-btn').addEventListener('click', applyBulk);
    // Filtering only hides rows - ticks and typed values stay as they are.
    $('vg-filter').addEventListener('input', () => {
      const f = $('vg-filter').value.toLowerCase();
      document.querySelectorAll('#variant-grid .vg-row').forEach((tr) => {
        tr.hidden = !!f && tr.querySelector('.vg-label').textContent.toLowerCase().indexOf(f) === -1;
      });
      document.querySelectorAll('#variant-grid .vg-photo-row').forEach((x) => x.remove());
    });
  }

  return { init, load, setListingType, payload, changeSummary, uploadPending, labels, previewProduct, get mode() { return mode; } };
})();
