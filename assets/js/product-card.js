// Shared storefront product-card renderer, used by store.html.
function renderProductCard(product) {
  const options = product.variants
    .map((v) => `<option value="${v.variantId}" data-price="${v.price}">${escapeHtml(v.label)} — ${formatMoney(v.price)}</option>`)
    .join('');

  const media =
    product.imageUrl && product.imageUrl2
      ? `<div class="product-gallery-track">
          <img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="Photo 1 of ${escapeHtml(product.name)}" loading="lazy">
          <img class="product-image" src="${escapeHtml(product.imageUrl2)}" alt="Photo 2 of ${escapeHtml(product.name)}" loading="lazy">
        </div>`
      : product.imageUrl
      ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
      : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const thumbs =
    product.imageUrl && product.imageUrl2
      ? `<div class="product-gallery-thumbs">
          <button type="button" class="product-gallery-thumb active" data-index="0"><img src="${escapeHtml(product.imageUrl)}" alt="Photo 1 of ${escapeHtml(product.name)}"></button>
          <button type="button" class="product-gallery-thumb" data-index="1"><img src="${escapeHtml(product.imageUrl2)}" alt="Photo 2 of ${escapeHtml(product.name)}"></button>
        </div>`
      : '';

  return `
    <article class="product-card" data-product-id="${escapeHtml(product.productId)}">
      ${media}
      ${thumbs}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        ${product.description ? `<p class="product-desc">${escapeHtml(product.description)}</p>` : ''}
        <div class="product-controls">
          <label class="sr-only" for="variety-${escapeHtml(product.productId)}">Choose an option for ${escapeHtml(product.name)}</label>
          <select id="variety-${escapeHtml(product.productId)}" class="variety-select">${options}</select>
        </div>
        <div class="product-actions">
          <label class="sr-only" for="qty-${escapeHtml(product.productId)}">Quantity</label>
          <input id="qty-${escapeHtml(product.productId)}" class="qty-input" type="number" min="1" value="1" inputmode="numeric">
          <button type="button" class="btn btn-primary add-to-cart-btn" data-product-id="${escapeHtml(product.productId)}" data-product-name="${escapeHtml(product.name)}">
            Add to Cart
          </button>
        </div>
      </div>
    </article>
  `;
}
