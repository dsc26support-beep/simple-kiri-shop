function formatMoney(amount) {
  return APP_CONFIG.CURRENCY_SYMBOL + Number(amount || 0).toFixed(2);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

// Word-level fuzzy matching for "similar products": case differences never
// count, and a single-character edit (typo) doesn't either, but that's the
// only slack allowed - "rice" and "ride" match, "rice" and "rise" match,
// but "rice" and "race" (2 edits away is fine, this IS 1 edit - kept for
// illustration) ... in short: Levenshtein distance <= 1 after lowercasing.
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const currRow = [i];
    for (let j = 1; j <= n; j++) {
      currRow[j] =
        a[i - 1] === b[j - 1]
          ? prevRow[j - 1]
          : 1 + Math.min(prevRow[j - 1], prevRow[j], currRow[j - 1]);
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

function tokenizeProductName(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2); // skip tiny/common words (of, a, in, ...)
}

function wordsAreEquivalent(wordA, wordB) {
  if (wordA === wordB) return true;
  return levenshteinDistance(wordA, wordB) <= 1;
}

/** True if the two product names share at least one word (case-insensitive, 1-typo tolerant). */
function namesShareEquivalentWord(nameA, nameB) {
  const wordsA = tokenizeProductName(nameA);
  const wordsB = tokenizeProductName(nameB);
  return wordsA.some((wa) => wordsB.some((wb) => wordsAreEquivalent(wa, wb)));
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Shared "browse" card for a product from someone else's context (search
 * results, similar products, the home page trending carousel) - image,
 * name, store, delivery icons, price, and a link into that store. Distinct
 * from renderProductCard in product-card.js, which is the full add-to-cart
 * card shown on a store's own page.
 */
function renderBrowseProductCard(product, opts) {
  opts = opts || {};
  const linkLabel = opts.linkLabel || 'View';
  const cardClass = opts.cardClass || '';

  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const prices = product.variants.map((v) => v.price);
  const priceText =
    prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
      ? `${formatMoney(Math.min(...prices))} – ${formatMoney(Math.max(...prices))}`
      : formatMoney(prices[0]);

  return `
    <article class="product-card${cardClass ? ' ' + cardClass : ''}" data-product-id="${escapeHtml(product.productId)}">
      ${media}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <p class="helper-text">Sold by ${escapeHtml(product.storeName)}</p>
        ${product.storePhone ? `<p class="store-phone">${escapeHtml(product.storePhone)}</p>` : ''}
        ${renderDeliveryIcons({
          truck: product.storeDeliveryTruck,
          ship: product.storeDeliveryShip,
          airCargo: product.storeDeliveryAirCargo,
          truckCost: product.storeDeliveryTruckCost,
          shipCost: product.storeDeliveryShipCost,
          airCargoCost: product.storeDeliveryAirCargoCost
        })}
        <strong>${priceText}</strong>
        <a class="btn btn-primary" href="store.html?store=${encodeURIComponent(product.storeSlug)}">${escapeHtml(linkLabel)}</a>
      </div>
    </article>
  `;
}

/** Small circular-logo carousel item, for the home page "popular stores" row. */
function renderLogoCarouselItem(store) {
  const logo = store.logoUrl
    ? `<img class="logo-carousel-logo" src="${escapeHtml(store.logoUrl)}" alt="">`
    : `<div class="logo-carousel-logo-placeholder" aria-hidden="true">${escapeHtml(initials(store.storeName))}</div>`;
  return `
    <a class="logo-carousel-item" href="store.html?store=${encodeURIComponent(store.storeSlug)}">
      ${logo}
      <span class="logo-carousel-name">${escapeHtml(store.storeName)}</span>
    </a>
  `;
}

function getLocalIdSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key)) || []);
  } catch (e) {
    return new Set();
  }
}

function saveLocalIdSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch (e) {
    // storage full/unavailable - not worth failing over
  }
}

// Records a view for each productId not already seen on this device
// (deduped via localStorage - "once per visitor per product"). Fire-and-
// forget: never blocks rendering or shows an error to the customer.
function recordProductViewsOnce(productIds) {
  const seen = getLocalIdSet('skiri_viewed_products');
  const newIds = (productIds || []).filter((id) => id && !seen.has(id));
  if (newIds.length === 0) return;
  newIds.forEach((id) => seen.add(id));
  saveLocalIdSet('skiri_viewed_products', seen);
  Api.post('recordProductViews', { productIds: newIds }).catch(() => {});
}

// Same idea as recordProductViewsOnce, for a single store visit.
function recordStoreVisitOnce(storeSlug) {
  if (!storeSlug) return;
  const seen = getLocalIdSet('skiri_visited_stores');
  if (seen.has(storeSlug)) return;
  seen.add(storeSlug);
  saveLocalIdSet('skiri_visited_stores', seen);
  Api.post('recordStoreVisit', { storeSlug }).catch(() => {});
}

// Downscale/compress a photo client-side before upload - mobile camera
// photos can be 5-10MB, which is both slow on Kiribati mobile data and
// close to the Apps Script POST size limit once base64-encoded (~33% larger).
// Used for both product photos and store logos.
function compressImage(file, maxDimension = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          const scale = maxDimension / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            const outReader = new FileReader();
            outReader.onload = () => {
              const base64 = outReader.result.split(',')[1];
              resolve({ base64, mimeType: 'image/jpeg' });
            };
            outReader.onerror = reject;
            outReader.readAsDataURL(blob);
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// South Tarawa villages are specific enough to show on their own; every
// other island is spread out enough that the island name is more useful
// than a single village. Falls back to whichever of the two is set.
function storeLocationLabel(island, village) {
  if (!island) return village || '';
  if (island === 'South Tarawa' && village) return village;
  return island;
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

// Kept in sync with the category <select> options in owner/products.html.
const CATEGORIES = [
  { id: 'pantry', label: 'Pantry / Food' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'household', label: 'Household' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'general', label: 'General' }
];

function renderCategoryButtons(containerId) {
  document.getElementById(containerId).innerHTML = CATEGORIES.map(
    (c) => `<a class="btn category-btn" href="search.html?category=${encodeURIComponent(c.id)}">${escapeHtml(c.label)}</a>`
  ).join('');
}

// Self-contained inline-SVG icons (no external icon library/CDN) - keep the
// site working offline-first on limited mobile data.
const DELIVERY_ICON_SVG = {
  truck: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="14" height="10"></rect><path d="M15 10h4l3 3v4h-7z"></path><circle cx="6" cy="18" r="1.5"></circle><circle cx="17.5" cy="18" r="1.5"></circle></svg>',
  ship: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h17l3 3-3 3H5l-3-3z"></path><rect x="4" y="10" width="5" height="4"></rect><path d="M6.5 10V5"></path><rect x="11" y="8" width="6" height="6"></rect><path d="M14 8v6M11 11h6"></path></svg>',
  airCargo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v7"></path><path d="M12 9l9 5v2l-9-3-9 3v-2z"></path><path d="M9 19l3-2 3 2"></path><path d="M12 17v4"></path></svg>'
};
const DELIVERY_ICON_LABELS = { truck: 'Truck delivery', ship: 'Ship delivery', airCargo: 'Air cargo delivery' };

/**
 * flags: {truck, ship, airCargo} booleans, plus optional {truckCost,
 * shipCost, airCargoCost} numbers - renders 0-3 small labeled icons. A cost
 * of exactly 0 means free delivery for that method and turns its icon green;
 * a missing/null cost just omits the price from the label (store hasn't set
 * one yet).
 */
function renderDeliveryIcons(flags) {
  flags = flags || {};
  const methods = ['truck', 'ship', 'airCargo'].filter((m) => flags[m]);
  if (methods.length === 0) return '';
  return `<span class="delivery-icons">${methods
    .map((m) => {
      const cost = flags[m + 'Cost'];
      const isFree = cost === 0;
      const priceText = cost == null ? '' : cost === 0 ? ' — Free' : ` — ${formatMoney(cost)}`;
      const label = DELIVERY_ICON_LABELS[m] + priceText;
      return `<span class="delivery-icon${isFree ? ' delivery-icon-free' : ''}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${DELIVERY_ICON_SVG[m]}</span>`;
    })
    .join('')}</span>`;
}

const EYE_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const EYE_OFF_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-2.94 4.06M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>';

/**
 * Wraps a password input with a show/hide toggle button. Safe to call once
 * per password field at page init - no-ops if the input isn't found.
 */
function wirePasswordToggle(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'password-field';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'password-toggle';
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = EYE_ICON_SVG;
  wrapper.appendChild(btn);

  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? EYE_ICON_SVG : EYE_OFF_ICON_SVG;
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    btn.setAttribute('aria-pressed', String(!showing));
  });
}
