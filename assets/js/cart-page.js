document.addEventListener('DOMContentLoaded', init);

let currentSlug = null;

async function init() {
  currentSlug = localStorage.getItem('skiri_active_store');

  if (!currentSlug) {
    render();
    return;
  }

  document.getElementById('back-to-store-link').href = `store.html?store=${encodeURIComponent(currentSlug)}`;

  const res = await Api.get('getStorePublicInfo', { storeSlug: currentSlug });
  if (res.ok) {
    document.getElementById('store-name-tagline').textContent = `Your cart — ${res.store.storeName}`;
    if (res.store.phone) {
      const phoneLine = document.getElementById('store-phone-line');
      phoneLine.textContent = res.store.phone;
      phoneLine.classList.remove('hidden');
    }
  }

  document.getElementById('cart-items').addEventListener('click', onCartClick);
  document.getElementById('cart-items').addEventListener('change', onCartChange);

  render();
}

function render() {
  const emptyEl = document.getElementById('cart-empty');
  const contentEl = document.getElementById('cart-content');
  const itemsEl = document.getElementById('cart-items');
  const liveEl = document.getElementById('cart-live');

  const cart = currentSlug ? Cart.getCart(currentSlug) : [];

  if (cart.length === 0) {
    emptyEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    liveEl.textContent = 'Your cart is empty.';
    return;
  }

  emptyEl.classList.add('hidden');
  contentEl.classList.remove('hidden');

  itemsEl.innerHTML = cart
    .map(
      (line) => `
      <div class="cart-line" data-variant-id="${escapeHtml(line.variantId)}">
        <div class="cart-line-info">
          <strong>${escapeHtml(line.label)}</strong><br>
          <span class="helper-text">${formatMoney(line.unitPrice)} each</span>
        </div>
        <label class="sr-only" for="qty-${escapeHtml(line.variantId)}">Quantity for ${escapeHtml(line.label)}</label>
        <input id="qty-${escapeHtml(line.variantId)}" class="cart-line-qty" type="number" min="1" value="${line.qty}" inputmode="numeric">
        <strong>${formatMoney(line.unitPrice * line.qty)}</strong>
        <button type="button" class="btn btn-danger btn-small" data-action="remove">Remove</button>
      </div>
    `
    )
    .join('');

  document.getElementById('cart-total').textContent = formatMoney(Cart.getTotal(currentSlug));
  liveEl.textContent = `${Cart.getItemCount(currentSlug)} item(s) in your cart.`;
}

function onCartClick(e) {
  const btn = e.target.closest('[data-action="remove"]');
  if (!btn) return;
  const variantId = btn.closest('.cart-line').dataset.variantId;
  Cart.removeItem(currentSlug, variantId);
  render();
}

function onCartChange(e) {
  if (!e.target.classList.contains('cart-line-qty')) return;
  const variantId = e.target.closest('.cart-line').dataset.variantId;
  const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  Cart.updateQty(currentSlug, variantId, qty);
  render();
}
