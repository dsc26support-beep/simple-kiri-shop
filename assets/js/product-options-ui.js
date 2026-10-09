// Product page: the option picker and photo gallery for products with
// options, and the gallery for single products (product.html).
//
// The availability rules come from product-options.js - a generated copy of
// apps-script/ProductOptions.gs - so the page and the backend agree on what
// can be bought. The backend re-checks the variant, price and stock when the
// order is placed; nothing chosen here is trusted.
//
// Rules the shopper sees:
//   - nothing is pre-selected; Add to Cart waits for a choice of every option;
//   - a combination that isn't sold is disabled and says why;
//   - a sold-out one stays visible, marked, and can't be added;
//   - choosing a value that rules out another choice clears that choice and
//     says so - a different variant is never substituted silently;
//   - picking a colour (or a full combination) swaps in its own photos.
const OptionsUI = (() => {
  const PDP_SIZES = '(max-width: 700px) 100vw, 520px';

  function ownImages(product) {
    const out = [];
    [product.imageUrl, product.imageUrl2].forEach((u) => { if (u && out.indexOf(u) === -1) out.push(u); });
    return out;
  }

  /** The photos for what is chosen so far. Never another colour's photos. */
  function galleryFor(product, picked) {
    const variants = product.variants || [];
    if (product.productType === 'single') {
      const imgs = ownImages(product);
      variants.forEach((v) => (v.images || []).forEach((u) => { if (imgs.indexOf(u) === -1) imgs.push(u); }));
      return imgs.map((url) => ({ url }));
    }
    const options = product.options || [];
    const exact = variantForSelection(options, variants, picked);
    if (exact && exact.images && exact.images.length) return exact.images.map((url) => ({ url }));
    const colour = options.filter((o) => o.kind === 'colour')[0];
    if (colour && picked[colour.id]) {
      // Same colour, any size: the photos of that colour.
      const sib = variants.filter((v) => v.values && v.values[colour.id] === picked[colour.id] && v.images && v.images.length)[0];
      if (sib) return sib.images.map((url) => ({ url }));
      return ownImages(product).map((url) => ({ url }));
    }
    return cardGalleryImages(product);
  }

  function galleryHtml(product, images) {
    if (!images.length) {
      return `<div class="placeholder-swatch category-${escapeHtml(categoryIdOf(product.category))}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;
    }
    return carouselHtml(images, { width: IMG_W.card, sizes: PDP_SIZES, label: product.name, thumbs: true, eager: true, cls: 'carousel--pdp' });
  }

  function pickerHtml(product) {
    const pid = escapeHtml(product.productId);
    const groups = (product.options || []).map((o) => `
      <fieldset class="option-group" data-option="${escapeHtml(o.id)}">
        <legend>${escapeHtml(o.name)}: <span class="option-chosen">choose one</span></legend>
        <div class="option-values">${o.values.map((v) => `<button type="button" class="option-value" data-value="${escapeHtml(v.id)}" aria-pressed="false">${o.kind === 'colour' ? `<span class="option-dot"${swatchStyle(v)}></span>` : ''}<span class="option-label">${escapeHtml(v.label)}</span></button>`).join('')}</div>
      </fieldset>`).join('');
    return `<div class="option-picker" id="options-${pid}">${groups}
      <p class="option-note" id="option-note-${pid}" role="status"></p>
      <p class="option-status" id="option-status-${pid}" aria-live="polite"></p>
    </div>`;
  }

  function stockText(v) {
    if (v.stockQty == null) return '<span class="option-stock">In stock</span>';
    if (v.stockQty <= 0) return '<span class="option-stock option-stock--out">Sold out</span>';
    if (v.stockQty <= 5) return `<span class="option-stock option-stock--low">Only ${v.stockQty} left</span>`;
    return '<span class="option-stock">In stock</span>';
  }

  /**
   * Wires the picker. onChange(variantOrNull) fires after every choice, with
   * the exact variant when the selection is complete AND it can be bought.
   */
  function wire(product, root, onChange) {
    const options = product.options || [];
    const variants = product.variants || [];
    const picked = {};
    const pid = product.productId;
    const status = root.querySelector('#option-status-' + CSS.escape(pid));
    const note = root.querySelector('#option-note-' + CSS.escape(pid));
    const galleryRoot = root.querySelector('.pdp-gallery');
    let lastGalleryKey = '';

    function refresh() {
      options.forEach((o) => {
        const group = root.querySelector(`.option-group[data-option="${CSS.escape(o.id)}"]`);
        const states = optionValueStates(options, variants, o.id, picked);
        // Disabled only if no combination with this value is sold at all. One
        // that just doesn't go with the other choices stays tappable: tapping
        // it clears the choice it conflicts with, and the page says so.
        const anyStates = optionValueStates(options, variants, o.id, {});
        group.querySelectorAll('.option-value').forEach((btn) => {
          const st = states[btn.dataset.value] || 'none';
          const label = btn.querySelector('.option-label').textContent;
          btn.disabled = (anyStates[btn.dataset.value] || 'none') === 'none';
          btn.classList.toggle('is-conflict', st === 'none' && !btn.disabled);
          btn.classList.toggle('is-soldout', st === 'soldout');
          btn.setAttribute('aria-pressed', String(picked[o.id] === btn.dataset.value));
          const others = Object.keys(picked).filter((k) => k !== o.id && picked[k]).map((k) => {
            const opt = options.filter((x) => x.id === k)[0];
            const val = opt && opt.values.filter((x) => x.id === picked[k])[0];
            return val ? val.label : '';
          }).filter(Boolean).join(' / ');
          const why = st === 'none' ? (others && !btn.disabled ? `not sold in ${others} - choosing it clears that` : 'not sold') : st === 'soldout' ? 'sold out' : '';
          btn.setAttribute('aria-label', label + (why ? ', ' + why : ''));
          btn.title = why ? label + ' - ' + why : '';
        });
        const chosen = o.values.filter((v) => v.id === picked[o.id])[0];
        group.querySelector('.option-chosen').textContent = chosen ? chosen.label : 'choose one';
      });

      const missing = options.filter((o) => !picked[o.id]).map((o) => o.name.toLowerCase());
      const exact = missing.length ? null : variantForSelection(options, variants, picked);
      let html;
      if (missing.length) {
        html = `${escapeHtml(formatPriceLabel(variants))} · Choose ${escapeHtml(missing.join(' and '))}`;
      } else if (!exact) {
        html = '<span class="option-stock option-stock--out">This combination is not sold</span>';
      } else {
        html = `<strong>${escapeHtml(formatMoney(exact.price))}</strong> · ${stockText(exact)}${exact.sku ? ` · <span class="option-sku">SKU ${escapeHtml(exact.sku)}</span>` : ''}`;
      }
      status.innerHTML = html;

      const images = galleryFor(product, picked);
      const key = images.map((i) => i.url).join('|');
      if (galleryRoot && key !== lastGalleryKey) {
        lastGalleryKey = key;
        galleryRoot.innerHTML = galleryHtml(product, images);
      }
      const buyable = exact && (exact.stockQty == null || exact.stockQty > 0) ? exact : null;
      onChange(buyable, { missing, exact });
    }

    root.querySelector('.option-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('.option-value');
      if (!btn || btn.disabled) return;
      const optionId = btn.closest('.option-group').dataset.option;
      note.textContent = '';
      if (picked[optionId] === btn.dataset.value) {
        delete picked[optionId];
      } else {
        picked[optionId] = btn.dataset.value;
        // A choice that no longer goes with this one is cleared - and said.
        options.forEach((o) => {
          if (o.id === optionId || !picked[o.id]) return;
          const st = optionValueStates(options, variants, o.id, picked)[picked[o.id]];
          if (st === 'none') {
            const was = o.values.filter((v) => v.id === picked[o.id])[0];
            const now = options.filter((x) => x.id === optionId)[0].values.filter((v) => v.id === btn.dataset.value)[0];
            delete picked[o.id];
            note.textContent = `${o.name} ${was ? was.label : ''} isn’t sold in ${now ? now.label : 'that choice'}, so it was cleared. Please choose again.`;
          }
        });
      }
      refresh();
    });
    refresh();
  }

  return { galleryFor, galleryHtml, pickerHtml, wire };
})();
