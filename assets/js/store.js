document.addEventListener('DOMContentLoaded', init);

let currentProducts = [];
let currentSlug = null;
let currentStorePhone = null;
let currentStoreMessenger = null;

async function init() {
  currentSlug = getQueryParam('store');
  const statusEl = document.getElementById('products-status');
  const listEl = document.getElementById('product-list');

  if (!currentSlug) {
    statusEl.textContent = 'No store specified. Go back to the store directory.';
    return;
  }

  localStorage.setItem('skiri_active_store', currentSlug);

  const stopLoading = startLoadingMessage(statusEl);
  const res = await Api.get('listProducts', { storeSlug: currentSlug });
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  document.title = res.storeName + ' — Mwakete';
  const location = storeLocationLabel(res.storeIsland, res.storeVillage);
  document.getElementById('store-name-tagline').textContent = location ? `${res.storeName} | ${location}` : res.storeName;

  if (res.storeLogoUrl) {
    const logoImg = document.getElementById('store-logo-img');
    logoImg.src = optimizedImageUrl(res.storeLogoUrl, IMG_W.logo);
    logoImg.alt = res.storeName;
    logoImg.classList.remove('hidden');
  }

  currentStorePhone = res.storePhone || null;
  currentStoreMessenger = res.storeMessenger || null;

  const phoneLine = document.getElementById('store-phone-line');
  if (res.storePhone) {
    phoneLine.textContent = res.storePhone;
    phoneLine.classList.remove('hidden');
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

  currentProducts = res.products;

  if (currentProducts.length === 0) {
    statusEl.textContent = 'This store has no products listed yet.';
  } else {
    statusEl.textContent = '';
    listEl.innerHTML = currentProducts.map(renderProductCard).join('');
    fitPriceLabels(listEl);
    recordProductViewsOnce(currentProducts.map((p) => p.productId));
  }

  recordStoreVisitOnce(currentSlug);
  updateCartCount();
  wireProductEvents();
  wireGalleryScrollSync();
  wireProductsSearch();
  loadSimilarProducts();
  scrollToRequestedProduct();
}

// Filters this store's own already-loaded product list client-side - no
// extra request, since currentProducts is the store's full catalog (unlike
// the paginated cross-store directory on stores.html, a single store's
// products are all loaded up front already).
function filterCurrentProducts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return currentProducts;
  return currentProducts.filter((p) => {
    const haystack = `${p.name} ${p.description || ''} ${p.category || ''}`.toLowerCase();
    return haystack.indexOf(q) !== -1;
  });
}

function renderFilteredProducts(query) {
  const statusEl = document.getElementById('products-status');
  const listEl = document.getElementById('product-list');
  const filtered = filterCurrentProducts(query);

  if (filtered.length === 0) {
    statusEl.textContent = query.trim() ? `No products match "${query.trim()}".` : 'This store has no products listed yet.';
    listEl.innerHTML = '';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = filtered.map(renderProductCard).join('');
  fitPriceLabels(listEl);
  // Re-render replaces the gallery track elements, and their scroll sync
  // (wireGalleryScrollSync) is per-element, not delegated like the click
  // handler in wireProductEvents - has to be redone after every re-render.
  wireGalleryScrollSync();
}

// Live-filters as the customer types (debounced), same pattern as the store
// directory search on stores.html - Enter/Search button also works.
function wireProductsSearch() {
  const form = document.getElementById('products-search-form');
  const input = document.getElementById('products-search-input');
  let debounceTimer = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    renderFilteredProducts(input.value);
  });

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderFilteredProducts(input.value), 300);
  });
}

// Trending-product cards on the home page link here with ?product=<id> so a
// customer landing on a store with many listings sees the exact item they
// clicked, not just the top of the catalog - then finds "Similar Products"
// naturally below it, same as any other visit to this page.
function scrollToRequestedProduct() {
  const productId = getQueryParam('product');
  if (!productId) return;
  const card = document.querySelector(`.product-card[data-product-id="${CSS.escape(productId)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('product-highlight');
  card.addEventListener('animationend', () => card.classList.remove('product-highlight'), { once: true });
}

async function loadSimilarProducts() {
  if (currentProducts.length === 0) return;

  const category = currentProducts[0].category || 'general';
  const res = await Api.get('searchProducts', { category });
  if (!res.ok) return;

  // Same category (via the search call above) is only half the bar - a
  // candidate also needs to share at least one equivalent word with one of
  // this store's own product names (case/1-typo insensitive), so "similar
  // products" actually resembles what's being viewed rather than just
  // sharing a broad category like "general".
  const ownNames = currentProducts.map((p) => p.name);
  const similar = res.products
    .filter((p) => p.storeSlug !== currentSlug)
    // Booking listings have no add-to-cart affordance, which
    // renderBrowseProductCard's grid assumes every card has.
    .filter((p) => !isBookingCategory(p.category))
    .filter((p) => ownNames.some((name) => namesShareEquivalentWord(name, p.name)))
    .slice(0, 10);
  if (similar.length === 0) return;

  document.getElementById('similar-products-list').innerHTML = similar
    .map((p) => renderBrowseProductCard(p, { cardClass: 'similar-product-card' }))
    .join('');
  document.getElementById('similar-section').classList.remove('hidden');
  // After unhiding: a hidden element has no width to measure against.
  fitPriceLabels(document.getElementById('similar-products-list'));
  recordProductViewsOnce(similar.map((p) => p.productId));
}

// Cart.addItem() is instant (localStorage) - this is a brief cosmetic
// flourish confirming the click registered, not a real wait state.
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

// A booking request is a one-shot action per card (unlike Add to Cart,
// which can repeat) - success leaves the button permanently disabled with a
// "Requested" label rather than reverting after a timeout.
async function onRequestBooking(btn) {
  const productId = btn.dataset.productId;
  const product = currentProducts.find((p) => p.productId === productId);
  if (!product) return;

  const statusEl = document.getElementById(`booking-status-${productId}`);
  const select = document.getElementById(`variety-${productId}`);
  const startInput = document.getElementById(`start-${productId}`);
  const endInput = document.getElementById(`end-${productId}`);
  const nameInput = document.getElementById(`name-${productId}`);
  const phoneInput = document.getElementById(`phone-${productId}`);
  const notesInput = document.getElementById(`notes-${productId}`);

  const customerName = nameInput.value.trim();
  const customerPhone = phoneInput.value.trim();
  if (!customerName || !customerPhone) {
    statusEl.textContent = 'Please enter your name and phone number.';
    return;
  }
  if (!startInput.value || !endInput.value) {
    statusEl.textContent = 'Please choose a start and end date.';
    return;
  }
  if (startInput.value >= endInput.value) {
    statusEl.textContent = 'End date must be after start date.';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Sending<span class="btn-saving-dots"><span></span><span></span><span></span></span>';
  statusEl.textContent = '';

  const res = await Api.post('createBookingRequest', {
    storeSlug: currentSlug,
    productId,
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
  renderBookingVendorContact(productId);
}

// Shown once a booking request succeeds, alongside the "vendor will
// confirm or decline" status - waiting on the vendor shouldn't mean the
// customer has no way to reach them in the meantime.
function renderBookingVendorContact(productId) {
  const contactEl = document.getElementById(`booking-contact-${productId}`);
  if (!contactEl) return;

  const buttons = [];
  if (currentStorePhone) {
    buttons.push(`<a class="btn btn-call" href="tel:${escapeHtml(currentStorePhone)}">${PHONE_ICON_SVG}Call Now</a>`);
  }
  if (currentStoreMessenger) {
    buttons.push(`<a class="btn btn-messenger" href="${escapeHtml(messengerUrl(currentStoreMessenger))}" target="_blank" rel="noopener">${MESSENGER_ICON_SVG}Messenger</a>`);
  }
  if (buttons.length === 0) return;

  contactEl.innerHTML = buttons.join('');
  contactEl.classList.remove('hidden');
}

function wireProductEvents() {
  document.getElementById('product-list').addEventListener('click', (e) => {
    const thumbBtn = e.target.closest('.product-gallery-thumb');
    if (thumbBtn) {
      const card = thumbBtn.closest('.product-card');
      const track = card.querySelector('.product-gallery-track');
      if (track) track.scrollTo({ left: track.clientWidth * Number(thumbBtn.dataset.index), behavior: 'smooth' });
      card.querySelectorAll('.product-gallery-thumb').forEach((b) => b.classList.remove('active'));
      thumbBtn.classList.add('active');
      return;
    }

    const bookingBtn = e.target.closest('.request-booking-btn');
    if (bookingBtn) {
      onRequestBooking(bookingBtn);
      return;
    }

    const btn = e.target.closest('.add-to-cart-btn');
    if (!btn) return;

    const productId = btn.dataset.productId;
    const product = currentProducts.find((p) => p.productId === productId);
    if (!product) return;

    const select = document.getElementById(`variety-${productId}`);
    const qtyInput = document.getElementById(`qty-${productId}`);
    const variant = product.variants.find((v) => v.variantId === select.value);
    if (!variant) return;
    const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);

    Cart.addItem(currentSlug, {
      variantId: variant.variantId,
      productId: product.productId,
      label: `${product.name} — ${variant.label}`,
      unitPrice: variant.price,
      qty
    });

    showAddingToCartState(btn);
    updateCartCount();
    const feedback = document.getElementById('cart-feedback');
    feedback.textContent = `Added ${qty} × ${product.name} (${variant.label}) to your cart.`;
    setTimeout(() => {
      feedback.textContent = '';
    }, 4000);
  });
}

// Scroll doesn't bubble, so each gallery track needs its own listener rather
// than the single delegated click listener used for the rest of the grid.
// Keeps the thumb dots in sync when the customer swipes the image directly
// instead of tapping a thumb.
function wireGalleryScrollSync() {
  document.querySelectorAll('.product-gallery-track').forEach((track) => {
    track.addEventListener(
      'scroll',
      () => {
        const index = Math.round(track.scrollLeft / track.clientWidth);
        const card = track.closest('.product-card');
        card.querySelectorAll('.product-gallery-thumb').forEach((b, i) => b.classList.toggle('active', i === index));
      },
      { passive: true }
    );
  });
}

function updateCartCount() {
  document.getElementById('cart-count').textContent = Cart.getItemCount(currentSlug);
}
