document.addEventListener('DOMContentLoaded', init);

let product = null;
let slug = null;

async function init() {
  slug = getQueryParam('store');
  const productId = getQueryParam('product');
  const statusEl = document.getElementById('product-status');

  if (!slug || !productId) {
    statusEl.textContent = 'Product not found.';
    return;
  }
  localStorage.setItem('skiri_active_store', slug); // lets the shared chat window know the store

  const backLink = document.getElementById('back-to-store-link');
  const viewStore = document.getElementById('view-store-link');
  const storeHref = `store.html?store=${encodeURIComponent(slug)}`;
  backLink.href = storeHref;
  viewStore.href = storeHref;

  const stop = startLoadingMessage(statusEl);
  const res = await Api.get('listProducts', { storeSlug: slug });
  stop();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  product = (res.products || []).find((p) => p.productId === productId);
  if (!product) {
    statusEl.textContent = 'Sorry, this product is no longer available.';
    return;
  }
  statusEl.textContent = '';

  // Store header
  document.getElementById('store-name-tagline').textContent = res.storeName || 'Store';
  if (res.storeLogoUrl) {
    const img = document.getElementById('store-logo-img');
    img.src = optimizedImageUrl(res.storeLogoUrl, IMG_W.logo);
    img.alt = res.storeName;
    img.classList.remove('hidden');
  }
  if (res.storePhone) {
    const ph = document.getElementById('store-phone-line');
    ph.textContent = res.storePhone;
    ph.classList.remove('hidden');
  }
  document.getElementById('store-delivery-icons').innerHTML = renderDeliveryIcons({
    truck: res.storeDeliveryTruck,
    ship: res.storeDeliveryShip,
    airCargo: res.storeDeliveryAirCargo,
    pickPay: res.storeDeliveryPickPay,
    truckCost: res.storeDeliveryTruckCost,
    shipCost: res.storeDeliveryShipCost,
    airCargoCost: res.storeDeliveryAirCargoCost
  });

  // Product detail (reuses the store-page product card markup)
  document.getElementById('product-detail').innerHTML = renderProductCard(product);
  document.title = `${product.name} — Mwakete`;
  wireActions();
  wireGallery();
}

function wireActions() {
  const addBtn = document.querySelector('#product-detail .add-to-cart-btn');
  if (addBtn) addBtn.addEventListener('click', () => onAddToCart(addBtn));
  const bookBtn = document.querySelector('#product-detail .request-booking-btn');
  if (bookBtn) bookBtn.addEventListener('click', () => onRequestBooking(bookBtn));
}

// Thumbnail gallery sync (mirrors store.js) - clicking a thumb scrolls the track.
function wireGallery() {
  document.querySelectorAll('#product-detail .product-gallery-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const track = document.querySelector('#product-detail .product-gallery-track');
      if (!track) return;
      const index = Number(thumb.dataset.index) || 0;
      track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    });
  });
}

// Compact single-product version of store.js's add-to-cart handler.
function onAddToCart(btn) {
  const select = document.getElementById(`variety-${product.productId}`);
  const qtyInput = document.getElementById(`qty-${product.productId}`);
  const variant = product.variants.find((v) => v.variantId === select.value);
  if (!variant) return;
  const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);

  Cart.addItem(slug, {
    variantId: variant.variantId,
    productId: product.productId,
    label: `${product.name} — ${variant.label}`,
    unitPrice: variant.price,
    qty
  });
  showAddingToCartState(btn);
  if (typeof updateBottomNavCartBadge === 'function') updateBottomNavCartBadge();
}

function showAddingToCartState(btn) {
  btn.disabled = true;
  btn.classList.add('btn-adding');
  btn.innerHTML = 'Adding<span class="btn-saving-dots"><span></span><span></span><span></span></span>';
  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove('btn-adding');
    btn.textContent = 'Add to Cart';
  }, 900);
}

// Compact single-product version of store.js's booking handler.
async function onRequestBooking(btn) {
  const pid = product.productId;
  const statusEl = document.getElementById(`booking-status-${pid}`);
  const select = document.getElementById(`variety-${pid}`);
  const startInput = document.getElementById(`start-${pid}`);
  const endInput = document.getElementById(`end-${pid}`);
  const nameInput = document.getElementById(`name-${pid}`);
  const phoneInput = document.getElementById(`phone-${pid}`);
  const notesInput = document.getElementById(`notes-${pid}`);

  const customerName = nameInput.value.trim();
  const customerPhone = phoneInput.value.trim();
  if (!customerName || !customerPhone) {
    statusEl.textContent = 'Please enter your name and phone number.';
    return;
  }
  if (!startInput.value || !endInput.value) {
    statusEl.textContent = 'Please choose a pick-up and return date.';
    return;
  }
  if (startInput.value >= endInput.value) {
    statusEl.textContent = 'Return date must be after pick-up date.';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Sending<span class="btn-saving-dots"><span></span><span></span><span></span></span>';
  statusEl.textContent = '';

  const res = await Api.post('createBookingRequest', {
    storeSlug: slug,
    productId: pid,
    variantId: select.value,
    startDate: startInput.value,
    endDate: endInput.value,
    customerName,
    customerPhone,
    notes: notesInput.value.trim()
  });

  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not send this booking request.';
    btn.disabled = false;
    btn.textContent = 'Request Booking';
    return;
  }
  btn.textContent = 'Requested';
  statusEl.textContent = 'Booking request sent — the vendor will confirm or decline.';
}
