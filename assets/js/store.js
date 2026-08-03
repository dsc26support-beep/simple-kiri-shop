document.addEventListener('DOMContentLoaded', init);

let currentProducts = [];
let currentSlug = null;

async function init() {
  currentSlug = getQueryParam('store');
  const statusEl = document.getElementById('products-status');
  const listEl = document.getElementById('product-list');

  if (!currentSlug) {
    statusEl.textContent = 'No store specified. Go back to the store directory.';
    return;
  }

  localStorage.setItem('skiri_active_store', currentSlug);

  const res = await Api.get('listProducts', { storeSlug: currentSlug });
  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not load this store.';
    return;
  }

  document.title = res.storeName + ' — Simple Kiri Shop';
  document.getElementById('store-name-tagline').textContent = res.storeName;

  if (res.storeLogoUrl) {
    const logoImg = document.getElementById('store-logo-img');
    logoImg.src = res.storeLogoUrl;
    logoImg.alt = res.storeName;
    logoImg.classList.remove('hidden');
  }

  const phoneLine = document.getElementById('store-phone-line');
  if (res.storePhone) {
    phoneLine.textContent = res.storePhone;
    phoneLine.classList.remove('hidden');
  }

  document.getElementById('store-delivery-icons').innerHTML = renderDeliveryIcons({
    truck: res.storeDeliveryTruck,
    ship: res.storeDeliveryShip,
    airCargo: res.storeDeliveryAirCargo
  });

  currentProducts = res.products;

  if (currentProducts.length === 0) {
    statusEl.textContent = 'This store has no products listed yet.';
  } else {
    statusEl.textContent = '';
    listEl.innerHTML = currentProducts.map(renderProductCard).join('');
  }

  updateCartCount();
  wireProductEvents();
  loadSimilarProducts();
}

async function loadSimilarProducts() {
  if (currentProducts.length === 0) return;

  const category = currentProducts[0].category || 'general';
  const res = await Api.get('searchProducts', { category });
  if (!res.ok) return;

  const similar = res.products.filter((p) => p.storeSlug !== currentSlug).slice(0, 10);
  if (similar.length === 0) return;

  document.getElementById('similar-products-list').innerHTML = similar.map(renderSimilarProductCard).join('');
  document.getElementById('similar-section').classList.remove('hidden');
}

function renderSimilarProductCard(product) {
  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;
  const prices = product.variants.map((v) => v.price);
  const priceText = prices.length ? formatMoney(Math.min(...prices)) : '';

  return `
    <article class="product-card similar-product-card">
      ${media}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <span class="helper-text">${escapeHtml(product.storeName)}</span>
        ${product.storePhone ? `<span class="store-phone">${escapeHtml(product.storePhone)}</span>` : ''}
        ${renderDeliveryIcons({ truck: product.storeDeliveryTruck, ship: product.storeDeliveryShip, airCargo: product.storeDeliveryAirCargo })}
        <strong>${priceText}</strong>
        <a class="btn btn-primary" href="store.html?store=${encodeURIComponent(product.storeSlug)}">View</a>
      </div>
    </article>
  `;
}

function wireProductEvents() {
  document.getElementById('product-list').addEventListener('click', (e) => {
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

    updateCartCount();
    const feedback = document.getElementById('cart-feedback');
    feedback.textContent = `Added ${qty} × ${product.name} (${variant.label}) to your cart.`;
    setTimeout(() => {
      feedback.textContent = '';
    }, 4000);
  });
}

function updateCartCount() {
  document.getElementById('cart-count').textContent = Cart.getItemCount(currentSlug);
}
