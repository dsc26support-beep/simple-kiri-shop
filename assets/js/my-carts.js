// "Your Carts" - every store this device has an unfinished cart with.
//
// Carts are per-store (skiri_cart_<slug>, see cart.js), so "the cart" is really
// several, and the header cart button had no honest single destination: it went
// to whichever store was visited last. This page is that destination.
//
// The useful half of each row - item count and subtotal - is already in
// localStorage, so rows are drawn immediately and only the store's name and
// logo wait on the backend. That also keeps the page still: the row's height is
// set by content that is there from the first paint.
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const slugs = cartStoreSlugs();

  // One cart is not a list. Send them straight to it rather than making them
  // tap through a page with a single row. replace(), not assign(), so Back
  // goes where they came from instead of bouncing off this redirect.
  if (slugs.length === 1) {
    location.replace(`cart.html?store=${encodeURIComponent(slugs[0])}`);
    return;
  }

  if (slugs.length === 0) {
    renderEmpty();
    return;
  }

  renderRows(slugs);
  await hydrateStoreNames(slugs);
}

function renderEmpty() {
  document.getElementById('my-carts-status').textContent = '';
  document.getElementById('my-carts-list').innerHTML = `
    <div class="empty-state">
      <p>You have no carts yet.</p>
      <p><a class="btn btn-primary" href="categories.html">Start browsing</a></p>
    </div>
  `;
}

/**
 * Drawn from localStorage alone, so this happens without waiting for anything.
 * The store name starts as the slug - readable, and never blank - and is
 * replaced with the real name once the lookup lands. Both are one line
 * (.my-cart-name is clamped in CSS), so the swap cannot change the row's
 * height and cannot move the page.
 */
function renderRows(slugs) {
  const rows = slugs.map((slug) => {
    const count = Cart.getItemCount(slug);
    const total = Cart.getTotal(slug);
    const noun = count === 1 ? 'item' : 'items';
    return `
      <div class="my-cart-row" data-store-slug="${escapeHtml(slug)}">
        <div class="my-cart-logo-slot" data-logo-for="${escapeHtml(slug)}">
          <div class="my-cart-logo-placeholder" aria-hidden="true">${escapeHtml(initials(slug))}</div>
        </div>
        <div class="my-cart-info">
          <p class="my-cart-name" data-name-for="${escapeHtml(slug)}">${escapeHtml(slug)}</p>
          <p class="my-cart-meta">${count} ${noun} · ${escapeHtml(formatMoney(total))}</p>
          <p class="my-cart-actions">
            <a class="btn btn-primary btn-small" href="cart.html?store=${encodeURIComponent(slug)}">View Cart</a>
            <a class="btn btn-small" href="store.html?store=${encodeURIComponent(slug)}">Keep Shopping</a>
          </p>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('my-carts-list').innerHTML = rows;
  const noun = slugs.length === 1 ? 'store' : 'stores';
  document.getElementById('my-carts-status').textContent =
    `You have carts with ${slugs.length} ${noun}. Each store is paid separately.`;
}

/**
 * Fills in real names and logos. One request per cart store, issued together -
 * typically two or three.
 *
 * A lookup that fails leaves that row showing its slug and keeps its actions
 * working. It never removes the row and never clears the cart: a failed
 * request is not proof the store is gone, and the cart is the shopper's.
 */
async function hydrateStoreNames(slugs) {
  const results = await Promise.all(
    slugs.map((slug) => Api.get('getStorePublicInfo', { storeSlug: slug }).catch(() => null))
  );

  results.forEach((res, i) => {
    if (!res || !res.ok || !res.store) return;
    const slug = slugs[i];
    const store = res.store;

    const nameEl = document.querySelector(`[data-name-for="${CSS.escape(slug)}"]`);
    if (nameEl && store.storeName) nameEl.textContent = store.storeName;

    if (!store.logoUrl) return;
    const slot = document.querySelector(`[data-logo-for="${CSS.escape(slug)}"]`);
    if (!slot) return;
    const img = document.createElement('img');
    img.className = 'my-cart-logo';
    img.src = optimizedImageUrl(store.logoUrl, IMG_W.logo);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    slot.replaceChildren(img);
  });
}
