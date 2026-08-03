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
    if (res.store.logoUrl) {
      const logoImg = document.getElementById('store-logo-img');
      logoImg.src = res.store.logoUrl;
      logoImg.alt = res.store.storeName;
      logoImg.classList.remove('hidden');
    }
    if (res.store.phone) {
      const phoneLine = document.getElementById('store-phone-line');
      phoneLine.textContent = res.store.phone;
      phoneLine.classList.remove('hidden');
    }
    document.getElementById('store-delivery-icons').innerHTML = renderDeliveryIcons({
      truck: res.store.deliveryTruck,
      ship: res.store.deliveryShip,
      airCargo: res.store.deliveryAirCargo,
      truckCost: res.store.deliveryTruckCost,
      shipCost: res.store.deliveryShipCost,
      airCargoCost: res.store.deliveryAirCargoCost
    });
  }

  document.getElementById('cart-items').addEventListener('click', onCartClick);
  document.getElementById('cart-items').addEventListener('input', onCartInput);
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
        <strong class="cart-line-total">${formatMoney(line.unitPrice * line.qty)}</strong>
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

// Fires on every keystroke - keeps the price in sync live as the customer
// types, without ever tearing down/rebuilding the input they're actively
// typing in (which would kick focus out after each digit). A transient
// empty/zero value while mid-edit (e.g. select-all then retype) is just
// skipped here rather than treated as "remove this line" - that's only
// committed on blur/Enter, in onCartChange below.
function onCartInput(e) {
  if (!e.target.classList.contains('cart-line-qty')) return;
  const qty = parseInt(e.target.value, 10);
  if (!(qty >= 1)) return;

  const line = e.target.closest('.cart-line');
  const variantId = line.dataset.variantId;
  const updatedCart = Cart.updateQty(currentSlug, variantId, qty);
  const updatedLine = updatedCart.find((l) => l.variantId === variantId);
  if (!updatedLine) return;

  line.querySelector('.cart-line-total').textContent = formatMoney(updatedLine.unitPrice * updatedLine.qty);
  document.getElementById('cart-total').textContent = formatMoney(Cart.getTotal(currentSlug));
  document.getElementById('cart-live').textContent = `${Cart.getItemCount(currentSlug)} item(s) in your cart.`;
}

// Fires on blur/Enter - the commit point. Handles the qty-dropped-to-0 case
// (removes the line) with a full re-render, since by now the customer is
// done editing and losing focus on this particular input doesn't matter.
function onCartChange(e) {
  if (!e.target.classList.contains('cart-line-qty')) return;
  const variantId = e.target.closest('.cart-line').dataset.variantId;
  const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  Cart.updateQty(currentSlug, variantId, qty);
  render();
}
