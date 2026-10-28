// Cart is scoped per store slug in localStorage: one checkout = one vendor,
// since each store arranges payment directly and separately with the
// customer. A shopper can hold separate in-progress carts for different
// stores without one clobbering the other.
const Cart = (function () {
  function storageKey(storeSlug) {
    return 'skiri_cart_' + storeSlug;
  }

  function getCart(storeSlug) {
    try {
      return JSON.parse(localStorage.getItem(storageKey(storeSlug))) || [];
    } catch (err) {
      return [];
    }
  }

  function saveCart(storeSlug, cart) {
    localStorage.setItem(storageKey(storeSlug), JSON.stringify(cart));
  }

  // Wholesale stores (owner decision, Oct 2026): a line may carry
  //   tiers  [{ minQty, price }] - cheaper prices for bigger quantities
  //   minQty the minimum order (absent = 1)
  // straight from the listing. unitPrice stays the normal price. This is only
  // what the shopper SEES - the server prices the order itself, with the same
  // rule (tierUnitPrice in ProductOptions.gs; tests/test-wholesale-tiers.js
  // checks the two agree).
  function minQtyOf(line) {
    const n = Number(line && line.minQty);
    return n > 1 && Math.floor(n) === n ? n : 1;
  }

  function unitPriceOf(line) {
    const base = Math.round(Number(line.unitPrice) * 100) / 100;
    let price = base;
    (Array.isArray(line.tiers) ? line.tiers : []).forEach((t) => {
      if (t && Number(line.qty) >= Number(t.minQty) && Number(t.price) > 0) price = Math.round(Number(t.price) * 100) / 100;
    });
    return Math.min(price, base);
  }

  function lineTotal(line) {
    return Math.round(unitPriceOf(line) * line.qty * 100) / 100;
  }

  // The next cheaper price the shopper could reach, or null: "Buy 50+ for $15.00 each".
  function nextTierOf(line) {
    const tiers = Array.isArray(line.tiers) ? line.tiers : [];
    return tiers.find((t) => t && Number(t.minQty) > Number(line.qty) && Number(t.price) < unitPriceOf(line)) || null;
  }

  // item: { variantId, productId, label, unitPrice, qty, tiers?, minQty? }
  // A line never sits below its minimum order: adding 1 of a "minimum 10"
  // item puts 10 in the cart.
  function addItem(storeSlug, item) {
    const cart = getCart(storeSlug);
    const existing = cart.find((line) => line.variantId === item.variantId);
    if (existing) {
      existing.qty += item.qty;
      if (item.imageUrl && !existing.imageUrl) existing.imageUrl = item.imageUrl;
      // The listing's latest bulk prices win over what the line was added with.
      if (item.tiers !== undefined || item.minQty !== undefined) {
        existing.tiers = item.tiers;
        existing.minQty = item.minQty;
        existing.unitPrice = item.unitPrice;
      }
      existing.qty = Math.max(existing.qty, minQtyOf(existing));
    } else {
      cart.push(Object.assign({}, item, { qty: Math.max(item.qty, minQtyOf(item)) }));
    }
    saveCart(storeSlug, cart);
    return cart;
  }

  function updateQty(storeSlug, variantId, qty) {
    let cart = getCart(storeSlug);
    if (qty <= 0) {
      cart = cart.filter((line) => line.variantId !== variantId);
    } else {
      cart.forEach((line) => {
        if (line.variantId === variantId) line.qty = Math.max(qty, minQtyOf(line));
      });
    }
    saveCart(storeSlug, cart);
    return cart;
  }

  function removeItem(storeSlug, variantId) {
    return updateQty(storeSlug, variantId, 0);
  }

  function clearCart(storeSlug) {
    saveCart(storeSlug, []);
  }

  function getTotal(storeSlug) {
    return getCart(storeSlug).reduce((sum, line) => sum + lineTotal(line), 0);
  }

  function getItemCount(storeSlug) {
    return getCart(storeSlug).reduce((sum, line) => sum + line.qty, 0);
  }

  // Number of DISTINCT products in the cart (by productId, so two varieties of
  // the same product count once). Separate from getItemCount (total quantity) -
  // the store-front cart button escalates its look by distinct-product count.
  function getDistinctProductCount(storeSlug) {
    const ids = {};
    getCart(storeSlug).forEach((line) => {
      ids[line.productId] = true;
    });
    return Object.keys(ids).length;
  }

  // Product pictures in the cart (owner request, 28 Oct 2026). A line keeps
  // imageUrl - the chosen option's own photo, else the product's main photo -
  // saved when it is added. Lines from before that (or re-ordered from an old
  // order) get theirs from the store's listing the first time a cart page
  // opens: fillPhotos, one listProducts call per store, at most once a page.
  function photoFor(product, variantId) {
    const v = (product.variants || []).filter((x) => x.variantId === variantId)[0];
    if (v && Array.isArray(v.images) && v.images[0]) return v.images[0];
    const own = typeof productOwnPhotos === 'function' ? productOwnPhotos(product) : [product.imageUrl];
    return own[0] || '';
  }

  const photoLookups = {};
  function fillPhotos(storeSlug) {
    const missing = getCart(storeSlug).filter((l) => !l.imageUrl && !l.noPhoto);
    if (!missing.length || typeof Api === 'undefined') return Promise.resolve(false);
    if (!photoLookups[storeSlug]) {
      photoLookups[storeSlug] = Api.get('listProducts', { storeSlug })
        .then((res) => (res && res.ok ? res.products || [] : null))
        .catch(() => null);
    }
    return photoLookups[storeSlug].then((products) => {
      if (!products) return false;   // offline or failed: try again on the next page
      const cart = getCart(storeSlug);
      let changed = false;
      cart.forEach((line) => {
        if (line.imageUrl || line.noPhoto) return;
        const p = products.filter((x) => x.productId === line.productId)[0];
        const url = p ? photoFor(p, line.variantId) : '';
        if (url) line.imageUrl = url; else line.noPhoto = true;   // no photo to find - stop asking
        changed = true;
      });
      if (changed) saveCart(storeSlug, cart);
      return changed;
    });
  }

  // The small picture for a line: the photo, or the product's initials in a
  // coloured square when there is none (yet). Decorative - the name is beside it.
  function thumbHtml(line, cls) {
    const c = 'cart-thumb' + (cls ? ' ' + cls : '');
    if (line.imageUrl) {
      const src = typeof optimizedImageUrl === 'function' ? optimizedImageUrl(line.imageUrl, IMG_W.thumb) : line.imageUrl;
      return `<img class="${c}" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`;
    }
    const name = String(line.label || '').split(' — ')[0];
    return `<span class="${c} cart-thumb--empty" aria-hidden="true">${escapeHtml(typeof initials === 'function' ? initials(name) : name.charAt(0))}</span>`;
  }

  return { getCart, addItem, updateQty, removeItem, clearCart, getTotal, getItemCount, getDistinctProductCount, unitPriceOf, lineTotal, minQtyOf, nextTierOf, photoFor, fillPhotos, thumbHtml };
})();
