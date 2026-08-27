// Shared storefront product-card renderer, used by store.html.
function renderProductCard(product) {
  const options = product.variants
    .map((v) => `<option value="${v.variantId}" data-price="${v.price}">${escapeHtml(v.label)} — ${formatMoney(v.price)}</option>`)
    .join('');

  const media =
    product.imageUrl && product.imageUrl2
      ? `<div class="product-gallery-track">
          <img class="product-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}" alt="Photo 1 of ${escapeHtml(product.name)}" loading="lazy" decoding="async">
          <img class="product-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl2, IMG_W.card))}" alt="Photo 2 of ${escapeHtml(product.name)}" loading="lazy" decoding="async">
        </div>`
      : product.imageUrl
      ? `<img class="product-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`
      : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const thumbs =
    product.imageUrl && product.imageUrl2
      ? `<div class="product-gallery-thumbs">
          <button type="button" class="product-gallery-thumb active" data-index="0"><img src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.thumb))}" alt="Photo 1 of ${escapeHtml(product.name)}" loading="lazy" decoding="async"></button>
          <button type="button" class="product-gallery-thumb" data-index="1"><img src="${escapeHtml(optimizedImageUrl(product.imageUrl2, IMG_W.thumb))}" alt="Photo 2 of ${escapeHtml(product.name)}" loading="lazy" decoding="async"></button>
        </div>`
      : '';

  const pid = escapeHtml(product.productId);

  // Same label as the browse cards use (formatPriceLabel in helpers.js), so
  // a product's price reads identically whether you meet it while browsing
  // or on the store's own page. Previously the price only existed inside
  // the variant <option> labels, which the grid layout buries.
  const priceText = formatPriceLabel(product.variants);

  if (isBookingCategory(product.category)) {
    const availabilityBadge =
      product.available === false
        ? '<span class="availability-badge availability-badge--unavailable">Booked today</span>'
        : product.available === true
        ? '<span class="availability-badge availability-badge--available">Available</span>'
        : '';
    return `
      <article class="product-card product-card--booking" data-product-id="${pid}">
        ${media}
        ${thumbs}
        <div class="product-card-body">
          <h3 class="product-name">${escapeHtml(product.name)} ${availabilityBadge}</h3>
          <strong class="product-price">${priceText}</strong>
          ${product.description ? `<p class="product-desc">${escapeHtml(product.description)}</p>` : ''}
          <div class="product-controls">
            <label class="sr-only" for="variety-${pid}">Choose a rate for ${escapeHtml(product.name)}</label>
            <select id="variety-${pid}" class="variety-select">${options}</select>
          </div>
          <div class="booking-dates-row">
            <label class="sr-only" for="start-${pid}">Start date</label>
            <input id="start-${pid}" class="booking-start-input" type="date">
            <label class="sr-only" for="end-${pid}">End date</label>
            <input id="end-${pid}" class="booking-end-input" type="date">
          </div>
          <div class="booking-contact-fields">
            <label class="sr-only" for="name-${pid}">Your name</label>
            <input id="name-${pid}" class="booking-name-input" placeholder="Your name">
            <label class="sr-only" for="phone-${pid}">Phone number</label>
            <input id="phone-${pid}" class="booking-phone-input" placeholder="Phone number" inputmode="tel">
            <label class="sr-only" for="notes-${pid}">Notes (optional)</label>
            <textarea id="notes-${pid}" class="booking-notes-input" placeholder="Notes (optional)"></textarea>
          </div>
          <div class="product-actions">
            <button type="button" class="btn btn-primary request-booking-btn" data-product-id="${pid}" data-product-name="${escapeHtml(product.name)}">
              Request Booking
            </button>
          </div>
          <p class="booking-request-status helper-text" id="booking-status-${pid}" role="status"></p>
          <div class="booking-vendor-contact hidden" id="booking-contact-${pid}"></div>
        </div>
      </article>
    `;
  }

  return `
    <article class="product-card" data-product-id="${pid}">
      ${media}
      ${thumbs}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <strong class="product-price">${priceText}</strong>
        ${product.description ? `<p class="product-desc">${escapeHtml(product.description)}</p>` : ''}
        <div class="product-controls">
          <label class="sr-only" for="variety-${pid}">Choose an option for ${escapeHtml(product.name)}</label>
          <select id="variety-${pid}" class="variety-select">${options}</select>
        </div>
        <div class="product-actions">
          <label class="sr-only" for="qty-${pid}">Quantity</label>
          <input id="qty-${pid}" class="qty-input" type="number" min="1" value="1" inputmode="numeric">
          <button type="button" class="btn btn-primary add-to-cart-btn" data-product-id="${pid}" data-product-name="${escapeHtml(product.name)}">
            Add to Cart
          </button>
        </div>
      </div>
    </article>
  `;
}
