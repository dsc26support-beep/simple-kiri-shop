// The round cart button on product cards (renderBrowseProductCard in
// helpers.js). One delegated listener for the whole page, so cards rendered
// later (similar products, a filtered store list) work without rewiring.
//
// One option: adds 1 straight away. Several options (sizes, weights...): a
// small picker opens on the card, and tapping an option adds 1 of it. The
// product data comes from BROWSE_CARD_PRODUCTS, filled as the cards render -
// no request.
//
// Carts are per store (cart.js), so a card from another store's row goes
// into THAT store's cart. Pages listen for 'cart:added' to refresh their own
// cart counters (store.js's floating button); the header badge is refreshed
// here.
document.addEventListener('click', onCardCartClick);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardCartPicker(true); });

function onCardCartClick(e) {
  const choice = e.target.closest('.card-cart-option');
  if (choice) {
    e.preventDefault();
    const picker = choice.closest('.card-cart-picker');
    const product = BROWSE_CARD_PRODUCTS.get(picker.dataset.cardKey);
    const variant = product && product.variants.find((v) => String(v.variantId) === choice.dataset.variantId);
    const btn = picker.parentElement.querySelector('.card-cart-btn');
    closeCardCartPicker(false);
    if (variant) addCardItem(product, variant, btn);
    return;
  }
  if (e.target.closest('.card-cart-close')) {
    e.preventDefault();
    closeCardCartPicker(true);
    return;
  }

  const btn = e.target.closest('.card-cart-btn');
  if (!btn) {
    if (!e.target.closest('.card-cart-picker')) closeCardCartPicker(false);
    return;
  }
  e.preventDefault();
  const product = BROWSE_CARD_PRODUCTS.get(btn.dataset.cardKey);
  if (!product || !product.variants || !product.variants.length) return;
  const open = btn.parentElement.querySelector('.card-cart-picker');
  closeCardCartPicker(false);
  if (open) return;   // second tap on the same button closes it
  if (product.variants.length === 1) {
    addCardItem(product, product.variants[0], btn);
  } else {
    openCardCartPicker(product, btn);
  }
}

function openCardCartPicker(product, btn) {
  const options = product.variants.map((v) => {
    const out = v.stockQty != null && v.stockQty <= 0;
    return `<button type="button" class="card-cart-option" data-variant-id="${escapeHtml(v.variantId)}"${out ? ' disabled' : ''}>`
      + `<span>${escapeHtml(v.label)}</span><strong>${out ? 'Sold out' : formatMoney(v.price)}</strong></button>`;
  }).join('');
  btn.insertAdjacentHTML('afterend',
    `<div class="card-cart-picker" role="group" aria-label="Choose an option for ${escapeHtml(product.name)}" data-card-key="${escapeHtml(browseCardKey(product))}">`
    + `<div class="card-cart-picker-head"><span>Choose one</span><button type="button" class="card-cart-close" aria-label="Close">&times;</button></div>`
    + options + '</div>');
  btn.setAttribute('aria-expanded', 'true');
  const first = btn.parentElement.querySelector('.card-cart-option:not([disabled])');
  if (first) first.focus();
}

function closeCardCartPicker(refocus) {
  document.querySelectorAll('.card-cart-picker').forEach((p) => {
    const btn = p.parentElement.querySelector('.card-cart-btn');
    p.remove();
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
  });
}

function addCardItem(product, variant, btn) {
  const slug = product.storeSlug;
  if (!slug || typeof Cart === 'undefined') return;
  const qty = clampToAvailableStock(slug, variant, 1, product.name);
  if (qty === null) return;
  const distinctBefore = Cart.getDistinctProductCount(slug);
  Cart.addItem(slug, {
    variantId: variant.variantId,
    productId: product.productId,
    label: `${product.name} — ${variant.label}`,   // same as the store page's Add to Cart
    unitPrice: variant.price,
    qty
  });
  if (typeof updateHeaderCartBadge === 'function') updateHeaderCartBadge();
  if (btn) {
    btn.classList.add('card-cart-btn--added');
    setTimeout(() => btn.classList.remove('card-cart-btn--added'), 1200);
  }
  const option = product.variants.length > 1 ? ` (${variant.label})` : '';
  const where = product.storeName ? `your ${product.storeName} cart` : 'your cart';
  announceCardCart(`Added 1 × ${product.name}${option} to ${where}.`);
  document.dispatchEvent(new CustomEvent('cart:added', { detail: { storeSlug: slug, productId: product.productId, distinctBefore } }));
}

// A short message at the bottom of the screen, also read out by screen readers.
let cardCartToastTimer = null;
function announceCardCart(text) {
  let el = document.getElementById('card-cart-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'card-cart-toast';
    el.className = 'card-cart-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-shown');
  clearTimeout(cardCartToastTimer);
  cardCartToastTimer = setTimeout(() => el.classList.remove('is-shown'), 2500);
}

// Product cards are rendered by several pages, often into a section that is
// shown later. Rather than each page remembering to fit the card prices and
// badges (fitPriceLabels / fitCardBadges, helpers.js), any change to the page
// re-fits them once per frame - so a long range like "$219.99-500.00" is
// shrunk, never cut, and each card shows as many badges as it has room for.
let cardPriceFitQueued = false;
function queueCardPriceFit() {
  if (cardPriceFitQueued) return;
  cardPriceFitQueued = true;
  requestAnimationFrame(() => {
    cardPriceFitQueued = false;
    document.querySelectorAll('.product-card-buy').forEach((row) => fitPriceLabels(row));
    fitCardBadges();
  });
}
document.addEventListener('DOMContentLoaded', () => {
  queueCardPriceFit();
  new MutationObserver((records) => {
    // Ignore our own changes - the price's font size and the badges that
    // fitCardBadges moves, hides and counts - or this would loop every frame.
    const own = (t) => t.nodeType === 1 && (t.classList.contains('product-price')
      || !!t.closest('.product-card-meta, .product-card-verified'));
    if (records.every((r) => own(r.target))) return;
    queueCardPriceFit();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
});
