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
  // Shared with the chat window (storeIsOpen in chat-window.js). Only an
  // explicit false closes, so an older backend still reads as open.
  window.__storeOpen = res.storeOpen !== false;

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
  if (!window.__storeOpen) {
    // Browsable but closed: keep the listing readable, take the buy buttons
    // out of play, and say why so a dead button never looks broken.
    document.querySelectorAll('#product-detail .add-to-cart-btn, #product-detail .request-booking-btn')
      .forEach((btn) => { btn.disabled = true; btn.title = 'This store is closed right now'; });
    const detail = document.getElementById('product-detail');
    const note = document.createElement('p');
    note.className = 'store-closed-note';
    note.innerHTML = '<span class="store-closed-pill">Closed</span> This store is not taking orders right now. You can still chat with them.';
    detail.insertBefore(note, detail.firstChild);
  }
  // Deliberately not awaited: reviews are supporting information, and a slow
  // (or absent) Reviews tab must never hold up the product itself.
  loadReviews(product.productId);
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

/* ---------- Ratings & reviews ---------- */

// Loaded after the product itself so a slow or missing Reviews tab can never
// delay or block the thing the customer actually came for.
async function loadReviews(productId) {
  const section = document.getElementById('reviews-section');
  const statusEl = document.getElementById('reviews-status');
  section.hidden = false;

  const stop = startLoadingMessage(statusEl);
  const res = await Api.get('listProductReviews', { productId });
  stop();

  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  statusEl.textContent = '';
  renderReviewSummary(res);
  renderReviewList(res.reviews || []);
  renderReviewForm(productId, res.reviews || []);
}

function renderReviewSummary(data) {
  const el = document.getElementById('reviews-summary');
  const count = Number(data.count) || 0;
  if (count === 0) {
    // Explicitly "none yet" rather than zero stars, which reads as a bad score.
    el.innerHTML = '<p class="helper-text">No reviews yet. Be the first to review this product.</p>';
    return;
  }

  const avg = Number(data.average);
  const dist = data.distribution || [0, 0, 0, 0, 0];
  const rows = [5, 4, 3, 2, 1]
    .map((star) => {
      const n = Number(dist[star - 1]) || 0;
      const pct = count ? Math.round((n / count) * 100) : 0;
      return `<div class="rating-bar-row">
          <span class="rating-bar-label">${star}★</span>
          <span class="rating-bar"><span class="rating-bar-fill" style="width:${pct}%"></span></span>
          <span class="rating-bar-count">${n}</span>
        </div>`;
    })
    .join('');

  el.innerHTML = `
    <div class="reviews-average">
      <strong class="reviews-average-value">${avg.toFixed(1)}</strong>
      ${renderStars(avg, count)}
      <span class="helper-text">${count} review${count === 1 ? '' : 's'}</span>
    </div>
    <div class="rating-bars">${rows}</div>`;
}

function renderReviewList(reviews) {
  const el = document.getElementById('reviews-list');
  el.innerHTML = reviews
    .map(
      (r) => `
      <article class="review-item">
        <div class="review-head">
          ${renderStars(r.rating, 1).replace(/<span class="rating-count">.*?<\/span>/, '')}
          <span class="review-author">${escapeHtml(r.customerName || 'Customer')}</span>
          ${r.verifiedPurchase ? '<span class="review-verified">✓ Verified purchase</span>' : ''}
        </div>
        ${r.comment ? `<p class="review-comment">${escapeHtml(r.comment)}</p>` : ''}
        <p class="review-date helper-text">${escapeHtml(formatReviewDate(r.createdAt))}</p>
      </article>`
    )
    .join('');
}

function formatReviewDate(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

// Only a signed-in customer can review, and only once. Everyone else is told
// why rather than being shown a form that will be rejected on submit.
function renderReviewForm(productId, reviews) {
  const slot = document.getElementById('review-form-slot');
  const signedIn = typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken();

  if (!signedIn) {
    slot.innerHTML =
      '<p class="helper-text review-signin-prompt">' +
      '<a href="customer-login.html">Sign in or create an account</a> to leave a review.</p>';
    return;
  }

  const profile = CustomerAuth.getProfile && CustomerAuth.getProfile();
  const mine = profile && reviews.some((r) => r.customerName === profile.name);
  if (mine) {
    slot.innerHTML = '<p class="helper-text">You have already reviewed this product.</p>';
    return;
  }

  slot.innerHTML = `
    <form class="review-form" id="review-form">
      <fieldset class="review-stars-field">
        <legend>Your rating</legend>
        ${[1, 2, 3, 4, 5]
          .map(
            (n) => `<label class="review-star-choice">
              <input type="radio" name="reviewRating" value="${n}" required>
              <span>${n}★</span>
            </label>`
          )
          .join('')}
      </fieldset>
      <div class="field">
        <label for="review-comment">Your review <span class="helper-text">(optional)</span></label>
        <textarea id="review-comment" rows="3" maxlength="1000"></textarea>
      </div>
      <p class="form-error hidden" id="review-error"></p>
      <button type="submit" class="btn btn-primary" id="review-submit">Submit review</button>
    </form>`;

  document.getElementById('review-form').addEventListener('submit', (e) => onSubmitReview(e, productId));
}

async function onSubmitReview(e, productId) {
  e.preventDefault();
  const errorEl = document.getElementById('review-error');
  const btn = document.getElementById('review-submit');
  const checked = document.querySelector('input[name="reviewRating"]:checked');

  errorEl.classList.add('hidden');
  if (!checked) {
    errorEl.textContent = 'Please choose a rating.';
    errorEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Submitting<span class="btn-saving-dots"><span></span><span></span><span></span></span>';

  const res = await Api.post('submitReview', {
    token: CustomerAuth.getToken(),
    productId,
    rating: Number(checked.value),
    comment: document.getElementById('review-comment').value.trim()
  });

  btn.disabled = false;
  btn.textContent = 'Submit review';

  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not submit your review.';
    errorEl.classList.remove('hidden');
    return;
  }
  await loadReviews(productId);
}
