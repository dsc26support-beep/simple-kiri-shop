// Shared storefront product-card renderer, used by store.html.
function renderProductCard(product) {
  const options = product.variants
    .map((v) => `<option value="${v.variantId}" data-price="${v.price}">${escapeHtml(v.label)} — ${formatMoney(v.price)}</option>`)
    .join('');

  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  return `
    <article class="product-card" data-product-id="${escapeHtml(product.productId)}">
      ${media}
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
