function formatMoney(amount) {
  return APP_CONFIG.CURRENCY_SYMBOL + Number(amount || 0).toFixed(2);
}

/**
 * The price label on a product card, from its variants' prices. A range
 * repeats neither the currency symbol nor spaces around the dash
 * ("$10.02-14.32", not "$10.02 – $14.32") - the spaced form ran the full
 * width of a half-width grid card with no slack, and wrapped onto a second
 * line as soon as the numbers grew past two digits.
 */
function formatPriceLabel(variants) {
  const prices = (variants || []).map((v) => v.price);
  if (prices.length === 0) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatMoney(min) : `${formatMoney(min)}-${Number(max).toFixed(2)}`;
}

// .product-price is `white-space: nowrap`, so a price that's too wide for
// its column overflows (and gets clipped by the card) instead of wrapping.
// This shrinks it just enough to fit rather than letting either happen.
const PRICE_FIT_MAX_REM = 1.15; // matches .product-price's CSS font-size
const PRICE_FIT_MIN_REM = 0.8;

/**
 * Auto-fits every price label under `root` (default: the whole document) to
 * its own column. Text width scales about linearly with font-size, so the
 * needed size comes from one width measurement rather than a shrink-by-a-
 * step-and-re-measure loop, which would reflow once per step per card.
 * Safe to call repeatedly - it resets to the CSS size before measuring, so
 * a re-fit after a resize can grow the text back as well as shrink it.
 */
function fitPriceLabels(root) {
  (root || document).querySelectorAll('.product-price').forEach((el) => {
    el.style.fontSize = '';
    const available = el.clientWidth;
    const needed = el.scrollWidth;
    if (!available || needed <= available) return;
    // 0.98 keeps it off the exact edge, where sub-pixel rounding can still clip.
    const fitted = PRICE_FIT_MAX_REM * (available / needed) * 0.98;
    el.style.fontSize = Math.max(PRICE_FIT_MIN_REM, fitted) + 'rem';
  });
}

// Cards change width on rotate/resize, so a size fitted to the old column
// can end up too big (or needlessly small) for the new one.
let priceFitResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(priceFitResizeTimer);
  priceFitResizeTimer = setTimeout(() => fitPriceLabels(), 150);
});

// Apps Script's own per-request execution-startup overhead means even a
// small/cached read can take a few seconds - a loading message that never
// changes reads as "frozen" past that point. Stage two exists purely to
// reassure the customer/vendor the page is still working, not stuck. The
// "..." in both stages is animated, bouncing-and-color-cycling dot markup
// (.loading-dots in styles.css - a distinct class from the plain
// currentColor .btn-saving-dots used for button "Saving…" states) rather
// than static periods, so it visibly moves instead of just sitting there.
const LOADING_MESSAGE_STAGE2_DELAY_MS = 3000;
const LOADING_DOTS_HTML = '<span class="loading-dots"><span></span><span></span><span></span></span>';

/**
 * Sets el's content to "Loading" + moving dots immediately, then to
 * "Please wait" + moving dots after LOADING_MESSAGE_STAGE2_DELAY_MS if it's
 * still going. Returns a stop() function - callers MUST call it as soon as
 * the request settles (success or failure), before setting el's real text,
 * so stage two never fires after the real content is already showing.
 */
function startLoadingMessage(el) {
  if (!el) return () => {};
  el.innerHTML = 'Loading' + LOADING_DOTS_HTML;
  const timer = setTimeout(() => {
    el.innerHTML = 'Please wait' + LOADING_DOTS_HTML;
  }, LOADING_MESSAGE_STAGE2_DELAY_MS);
  return function stopLoadingMessage() {
    clearTimeout(timer);
  };
}

// A centered, full-screen "Loading… / Please wait…" overlay (moving dots),
// for waits where there's no inline status element to write into - e.g. the
// checkout page's initial load and while an order is being placed. Reuses
// startLoadingMessage for the two-stage text. Returns a function that hides it;
// safe to create once and reuse (the overlay element is kept and toggled).
function showLoadingOverlay() {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="loading-overlay-card" role="status" aria-live="polite"></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('is-visible');
  const stop = startLoadingMessage(overlay.querySelector('.loading-overlay-card'));
  return function hideLoadingOverlay() {
    stop();
    overlay.classList.remove('is-visible');
  };
}

// Centered, auto-dismissing confirmation popup. Reuses the loading-overlay
// backdrop so it sits over the whole page, then fades itself out after `ms`
// and resolves - the caller awaits it before revealing the next screen.
// Used on checkout to confirm "the seller has been emailed" for a beat
// before the Order Received page appears.
function showOrderSentPopup(message, ms) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('order-sent-popup');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'order-sent-popup';
      overlay.className = 'loading-overlay';
      overlay.innerHTML =
        '<div class="order-sent-card" role="status" aria-live="polite">' +
        '<span class="order-sent-check" aria-hidden="true">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
        '</span><span class="order-sent-text"></span></div>';
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.order-sent-text').textContent = message;
    overlay.classList.add('is-visible');
    setTimeout(() => {
      overlay.classList.remove('is-visible');
      resolve();
    }, ms);
  });
}

// The failed state deliberately looks different from the loading state,
// not just says something different - static (no bounce) and one plain
// currentColor (not cycling red/gold/purple), so it reads at a glance as
// "this stopped trying," distinct from "still working."
const STATIC_DOTS_HTML = '<span class="static-dots"><span></span><span></span><span></span></span>';

function loadFailedMessageHtml() {
  return 'Refresh page' + STATIC_DOTS_HTML;
}

function showLoadFailedMessage(el) {
  if (!el) return;
  el.innerHTML = loadFailedMessageHtml();
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

// Target render widths (px) per image slot, sized to cover ~2x DPR of the
// actual CSS box so retina screens still look sharp: logos/thumbs render at
// 56-64px, product cards at ~170-260px, chat images at max 220px.
const IMG_W = { logo: 160, thumb: 160, card: 520, chat: 440 };

/**
 * Rewrites a stored image URL to request an appropriately-sized, modern-format
 * variant from whichever host serves it, instead of hotlinking the full ~1280px
 * original into a small slot. Provider-aware, idempotent (safe to call twice),
 * and defensive - any URL it doesn't recognise (data:/blob:/unknown host) is
 * returned unchanged.
 *   - Cloudinary: inserts f_auto (WebP/AVIF), q_auto (quality), c_limit,w_<N>
 *     (downscale, never upscale) after /image/upload/.
 *   - Google Drive CDN (lh3.googleusercontent.com/d/<id>): appends the =w<N>
 *     size suffix.
 * See apps-script/Utils.gs uploadImage/uploadToCloudinary for where these URL
 * shapes come from. Purely client-side - the backend still stores/returns the
 * full original.
 */
function optimizedImageUrl(url, width) {
  if (!url || typeof url !== 'string') return url;
  if (url.indexOf('res.cloudinary.com') !== -1) {
    const marker = '/image/upload/';
    const at = url.indexOf(marker);
    if (at === -1) return url;
    const after = at + marker.length;
    const rest = url.slice(after);
    if (/^(f_auto|q_auto|w_\d|c_)/.test(rest)) return url; // already transformed
    return url.slice(0, after) + 'f_auto,q_auto,c_limit,w_' + width + '/' + rest;
  }
  if (url.indexOf('lh3.googleusercontent.com/') !== -1) {
    return url.replace(/=[-\w]+$/, '') + '=w' + width; // strip any existing =w../=s.. then set ours
  }
  return url;
}

/**
 * Shared "browse" card for a product from someone else's context - the home
 * page's trending grid, search results, and a store page's similar-products
 * row. Marketplace-style ordering (photo, name, then the price as the
 * loudest element, then the smaller store/delivery meta), and the whole
 * card is a link straight to that product on its store page (store.html's
 * ?product= param triggers the scroll-to-and-highlight there), so there's
 * no separate "View" button to aim at. Distinct from renderProductCard in
 * product-card.js, which is the full add-to-cart card on a store's own page.
 */
function renderBrowseProductCard(product, opts) {
  opts = opts || {};
  const cardClass = opts.cardClass || '';

  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`
    : `<div class="placeholder-swatch category-${escapeHtml(product.category || 'general')}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const priceText = formatPriceLabel(product.variants);

  return `
    <a class="product-card${cardClass ? ' ' + cardClass : ''}" data-product-id="${escapeHtml(product.productId)}" href="product.html?store=${encodeURIComponent(product.storeSlug)}&product=${encodeURIComponent(product.productId)}" aria-label="${escapeHtml(product.name)}, ${escapeHtml(product.storeName)}">
      ${media}
      <div class="product-card-body">
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <strong class="product-price">${priceText}</strong>
        <p class="helper-text">${escapeHtml(product.storeName)}</p>
        <div class="store-phone-row">
          ${product.storePhone ? `<span class="store-phone">${escapeHtml(product.storePhone)}</span>` : ''}
          ${isBookingCategory(product.category)
            ? '' /* delivery flags are store-wide; they're meaningless (and misleading) on a rental/service listing, so suppress them here — the goods listings and the store page keep them */
            : renderDeliveryIcons({
                truck: product.storeDeliveryTruck,
                ship: product.storeDeliveryShip,
                airCargo: product.storeDeliveryAirCargo,
                pickPay: product.storeDeliveryPickPay,
                truckCost: product.storeDeliveryTruckCost,
                shipCost: product.storeDeliveryShipCost,
                airCargoCost: product.storeDeliveryAirCargoCost
              })}
        </div>
      </div>
    </a>
  `;
}

/** Small circular-logo carousel item, for the home page "popular stores" row. */
function renderLogoCarouselItem(store) {
  const logo = store.logoUrl
    ? `<img class="logo-carousel-logo" src="${escapeHtml(optimizedImageUrl(store.logoUrl, IMG_W.logo))}" alt="" loading="lazy" decoding="async">`
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

// Customer-facing quick-filter buttons (home page + search.html). A subset
// of the category <select> options in owner/products.html - "General" is
// still a valid category a vendor can pick, it just doesn't get its own
// browse button here.
const CATEGORIES = [
  { id: 'pantry', label: 'Pantry / Food' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'household', label: 'Household' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'rentals', label: 'Rentals' },
  { id: 'services', label: 'Services' }
];

function renderCategoryButtons(containerId) {
  document.getElementById(containerId).innerHTML = CATEGORIES.map(
    (c) => `<a class="btn category-btn category-btn--${c.id}" href="search.html?category=${encodeURIComponent(c.id)}">${escapeHtml(c.label)}</a>`
  ).join('');
}

// Kept in sync with apps-script/Products.gs's BOOKING_CATEGORIES - a
// Rentals/Services listing gets the date-range request flow instead of
// cart/checkout.
const BOOKING_CATEGORIES = ['rentals', 'services'];
function isBookingCategory(category) { return BOOKING_CATEGORIES.indexOf(category) !== -1; }

// Phone classification (§16). Local Kiribati customers must use a number
// starting 730 or 630; overseas customers are unrestricted. Auto-detected by
// country code: a +686 / 00686 / 686 prefix, OR no country code at all, is
// treated as local (the national part, after any 686, must then begin 730 or
// 630); any OTHER explicit country code (+64, 0061, …) is overseas and exempt.
// Overseas customers therefore need to include their country code.
function classifyKiribatiPhone(phone) {
  let s = String(phone || '').replace(/[\s()\-.]/g, '');
  let hasCountryCode = false;
  if (s.charAt(0) === '+') { s = s.slice(1); hasCountryCode = true; }
  else if (s.slice(0, 2) === '00') { s = s.slice(2); hasCountryCode = true; }

  if (s.slice(0, 3) === '686') return { local: true, national: s.slice(3) };
  if (hasCountryCode) return { local: false, national: s };
  return { local: true, national: s };
}

// True if the phone is acceptable: overseas numbers pass unconditionally;
// local numbers must start 730 or 630.
function isCustomerPhoneValid(phone) {
  const c = classifyKiribatiPhone(phone);
  if (!c.local) return true;
  return /^(730|630)/.test(c.national);
}

// Self-contained inline-SVG icons (no external icon library/CDN) - keep the
// site working offline-first on limited mobile data.
const DELIVERY_ICON_SVG = {
  truck: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="14" height="10"></rect><path d="M15 10h4l3 3v4h-7z"></path><circle cx="6" cy="18" r="1.5"></circle><circle cx="17.5" cy="18" r="1.5"></circle></svg>',
  ship: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h17l3 3-3 3H5l-3-3z"></path><rect x="4" y="10" width="5" height="4"></rect><path d="M6.5 10V5"></path><rect x="11" y="8" width="6" height="6"></rect><path d="M14 8v6M11 11h6"></path></svg>',
  airCargo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v7"></path><path d="M12 9l9 5v2l-9-3-9 3v-2z"></path><path d="M9 19l3-2 3 2"></path><path d="M12 17v4"></path></svg>',
  pickPay: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"></circle><line x1="12" y1="6" x2="10.5" y2="13"></line><line x1="12" y1="8" x2="9" y2="11"></line><line x1="11" y1="8" x2="15" y2="10"></line><line x1="10.5" y1="13" x2="8" y2="20"></line><line x1="10.5" y1="13" x2="15" y2="19"></line></svg>'
};
const DELIVERY_ICON_LABELS = { truck: 'Truck delivery', ship: 'Ship delivery', airCargo: 'Air cargo delivery', pickPay: 'Pick & Pay' };

// Pick & Pay (in-person pickup, pay at the store) has no cost field at all -
// unlike truck/ship/airCargo it's always free, so it always renders green
// with a "Free" label rather than reading a *Cost flag.
const ALWAYS_FREE_DELIVERY_METHODS = ['pickPay'];

/**
 * flags: {truck, ship, airCargo, pickPay} booleans, plus optional
 * {truckCost, shipCost, airCargoCost} numbers - renders 0-4 small labeled
 * icons. A cost of exactly 0 means free delivery for that method and turns
 * its icon green; a missing/null cost just omits the price from the label
 * (store hasn't set one yet). pickPay has no cost flag - see
 * ALWAYS_FREE_DELIVERY_METHODS above.
 */
function renderDeliveryIcons(flags) {
  flags = flags || {};
  const methods = ['truck', 'ship', 'airCargo', 'pickPay'].filter((m) => flags[m]);
  if (methods.length === 0) return '';
  return `<span class="delivery-icons">${methods
    .map((m) => {
      const alwaysFree = ALWAYS_FREE_DELIVERY_METHODS.indexOf(m) !== -1;
      const cost = alwaysFree ? 0 : flags[m + 'Cost'];
      const isFree = alwaysFree || cost === 0;
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

const PHONE_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>';

const MESSENGER_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.15 2 11.25c0 2.9 1.44 5.49 3.7 7.19V22l3.38-1.86c.9.25 1.86.38 2.92.38 5.52 0 10-4.15 10-9.27S17.52 2 12 2z"></path><path d="M7 13.5l3.5-3.5 2.5 2.5 3.5-3.5"></path></svg>';

const CHAT_NOTIFICATION_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

/**
 * A short, distinct two-note chime for new chat messages - synthesized via
 * Web Audio API rather than an embedded audio file (nothing to host/
 * license, stays tiny). Deliberately not a generic system "beep": a quick
 * rising perfect-fifth pluck (E6 -> B6) with a fast decay, chosen to read
 * as "chat message" without being jarring if it fires while browsing.
 * Silently no-ops if Web Audio is unavailable or blocked (e.g. the
 * browser's autoplay policy hasn't seen a user gesture yet on this page) -
 * the visual toast still gets the point across either way.
 */
function playChatNotificationSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    [
      { freq: 1318.51, start: 0, dur: 0.13 }, // E6
      { freq: 1975.53, start: 0.09, dur: 0.2 } // B6
    ].forEach(({ freq, start, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.2, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    });

    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch (e) {
    // Web Audio unsupported/blocked - nothing to do, see comment above.
  }
}

const CHAT_TOAST_AUTO_DISMISS_MS = 5000;

/**
 * A brief top-of-screen popup for a new chat message - deliberately
 * top-anchored, since both the chat FAB and the chat window itself are
 * bottom-anchored (see .chat-fab-btn/.chat-window in styles.css), so a
 * notification never visually collides with the thing it's about.
 * Auto-dismisses; clicking it runs onClick (typically "open/focus the
 * relevant conversation") and dismisses early.
 */
function showChatNotificationToast(text, onClick) {
  const toast = document.createElement('div');
  toast.className = 'chat-notification-toast';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<span class="chat-notification-toast-icon">${CHAT_NOTIFICATION_ICON_SVG}</span><span>${escapeHtml(text)}</span>`;

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('chat-notification-toast--visible');
    setTimeout(() => toast.remove(), 250);
  }

  toast.addEventListener('click', () => {
    if (onClick) onClick();
    dismiss();
  });

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('chat-notification-toast--visible'));
  setTimeout(dismiss, CHAT_TOAST_AUTO_DISMISS_MS);
}

/**
 * A vendor's Messenger field can be a bare username ("my.store.page"), an
 * @handle, or a full URL they pasted themselves - normalize all three into
 * a clickable https://m.me/... link (or pass an already-full URL through
 * unchanged) rather than assuming one particular input format.
 */
function messengerUrl(handle) {
  const trimmed = String(handle || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return 'https://m.me/' + encodeURIComponent(trimmed.replace(/^@/, '').replace(/^m\.me\//i, ''));
}

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
