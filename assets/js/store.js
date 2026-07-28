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

  currentProducts = res.products;

  if (currentProducts.length === 0) {
    statusEl.textContent = 'This store has no products listed yet.';
  } else {
    statusEl.textContent = '';
    listEl.innerHTML = currentProducts.map(renderProductCard).join('');
  }

  updateCartCount();
  wireProductEvents();
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
