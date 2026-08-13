document.addEventListener('DOMContentLoaded', init);

function init() {
  renderCategoryButtons('category-buttons');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  loadHomePageData();
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}

// One combined request for both carousels below, instead of two separate
// round trips - Apps Script's own per-request execution-startup overhead
// is the dominant cost for a page load like this, so halving the number of
// round trips is what actually moves the needle on "page feels slow," not
// anything about the Sheets reads themselves (both halves are still served
// from the same 300s caches actionListTopProducts/actionListTopStores use).
async function loadHomePageData() {
  const res = await Api.get('getHomePageData', {});
  if (!res.ok) {
    document.getElementById('trending-products-status').textContent = res.error || '';
    document.getElementById('trending-stores-status').textContent = res.error || '';
    return;
  }
  renderTrendingProducts(res.products);
  renderTrendingStores(res.stores);
}

function renderTrendingProducts(products) {
  const statusEl = document.getElementById('trending-products-status');
  const listEl = document.getElementById('trending-products-list');

  if (products.length === 0) {
    statusEl.textContent = 'No products yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = products.map(renderTrendingProductCard).join('');
  recordProductViewsOnce(products.map((p) => p.productId));
  wireTrendingCarouselFocus(listEl);
}

// Keeps whichever card is nearest the carousel's horizontal center scaled
// up (.is-focused in styles.css) as the customer scrolls/swipes through -
// re-evaluated on every scroll so the "focused" card keeps moving to
// whichever one is currently centered.
function wireTrendingCarouselFocus(track) {
  let ticking = false;

  function updateFocusedCard() {
    ticking = false;
    const cards = track.querySelectorAll('.trending-product-card');
    if (cards.length === 0) return;

    const trackRect = track.getBoundingClientRect();
    const trackCenter = trackRect.left + trackRect.width / 2;

    let closest = null;
    let closestDistance = Infinity;
    cards.forEach((card) => {
      const cardRect = card.getBoundingClientRect();
      const cardCenter = cardRect.left + cardRect.width / 2;
      const distance = Math.abs(cardCenter - trackCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = card;
      }
    });

    cards.forEach((card) => card.classList.toggle('is-focused', card === closest));
  }

  track.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateFocusedCard);
    },
    { passive: true }
  );

  updateFocusedCard();
}

// The whole card is a link to the product's store - on mobile only the
// photo shows (see .trending-product-card-body in styles.css), so the
// image itself has to be the click target rather than a separate "View"
// button buried in body text that's hidden there.
function renderTrendingProductCard(product) {
  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const prices = product.variants.map((v) => v.price);
  const priceText =
    prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
      ? `${formatMoney(Math.min(...prices))} – ${formatMoney(Math.max(...prices))}`
      : formatMoney(prices[0]);

  // aria-label on the link itself, not just the image's alt text, so the
  // accessible name still works when the body text collapses to none on
  // mobile (a bare placeholder-swatch is aria-hidden, so without this the
  // link would otherwise have no accessible name at all there).
  return `
    <a class="trending-product-card" href="store.html?store=${encodeURIComponent(product.storeSlug)}&product=${encodeURIComponent(product.productId)}" data-product-id="${escapeHtml(product.productId)}" aria-label="${escapeHtml(product.name)}, sold by ${escapeHtml(product.storeName)}">
      ${media}
      <div class="trending-product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        ${product.storePhone ? `<p class="store-phone">${escapeHtml(product.storePhone)}</p>` : ''}
        ${renderDeliveryIcons({
          truck: product.storeDeliveryTruck,
          ship: product.storeDeliveryShip,
          airCargo: product.storeDeliveryAirCargo,
          pickPay: product.storeDeliveryPickPay,
          truckCost: product.storeDeliveryTruckCost,
          shipCost: product.storeDeliveryShipCost,
          airCargoCost: product.storeDeliveryAirCargoCost
        })}
        <strong>${priceText}</strong>
      </div>
    </a>
  `;
}

function renderTrendingStores(stores) {
  const statusEl = document.getElementById('trending-stores-status');
  const listEl = document.getElementById('trending-stores-list');

  if (stores.length === 0) {
    statusEl.textContent = 'No stores yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = stores.map(renderLogoCarouselItem).join('');
}
