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
  // Not the inline prices on the homepage/search cards: those sit in the
  // heading at the name's own size and wrap to the next line when they don't
  // fit, so shrinking them here would fight that - and this also runs globally
  // on resize, which would undo it after the fact.
  (root || document).querySelectorAll('.product-price:not(.product-price--inline)').forEach((el) => {
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
 * Slugs this device has a non-empty cart for. Carts are per-store
 * (skiri_cart_<slug>, see cart.js), so a shopper who browsed three shops has
 * three of them and no way back to any but the one they remember.
 *
 * Same localStorage scan as bottom-nav.js's updateBottomNavCartBadge and
 * customer-messages.js's collectChatStores, including their try/catch: storage
 * can be unavailable in private mode, and a malformed entry must not take the
 * page down with it.
 */
function cartStoreSlugs() {
  const prefix = 'skiri_cart_';
  const slugs = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        const slug = key.slice(prefix.length);
        if (!slug) continue;
        try {
          const cart = JSON.parse(localStorage.getItem(key));
          if (Array.isArray(cart) && cart.length > 0) slugs.push(slug);
        } catch (e) { /* skip malformed cart */ }
      }
    }
  } catch (e) {
    // storage unavailable - treated as no carts
  }
  return slugs;
}

/**
 * Total items across every per-store cart on this device.
 *
 * Carts are scoped per store (skiri_cart_<slug>, see cart.js), so "the cart"
 * is really several. The one number a shopper wants on a header badge is the
 * sum, which is what this returns.
 *
 * Single home for the scan: bottom-nav.js used to keep its own copy and
 * directory.js has cartStoreSlugs() for a related question. Two is already
 * enough; a third would be one too many.
 */
function totalCartItemCount() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf('skiri_cart_') === 0) {
        try {
          (JSON.parse(localStorage.getItem(key)) || []).forEach((line) => {
            total += Number(line.qty) || 0;
          });
        } catch (e) { /* skip malformed cart */ }
      }
    }
  } catch (e) {
    // storage unavailable - treated as an empty cart
  }
  return total;
}

/**
 * Runs work that must not compete with the page's own first render.
 *
 * Everything on this site paints from one Apps Script request, and that
 * request is slow enough on a Kiribati mobile link that anything sharing the
 * window with it is felt directly. Unread badges, analytics beacons and the
 * chat header are all nice-to-have: they belong after the shopper can see
 * their products, not before.
 *
 * Idle alone is not enough - an idle callback fires happily while a request is
 * still in flight, so it yields the CPU but not the network. So each page
 * publishes its render-critical request as window.__criticalReady and this
 * waits for that to settle first (rejections included - a failed load must not
 * strand the badges forever).
 *
 * The setTimeout(0) matters: this is called from DOMContentLoaded handlers,
 * and script order means chat-window.js and bottom-nav.js run before the page
 * script that sets __criticalReady. Yielding once lets every handler register
 * its request before we look for one.
 *
 * requestIdleCallback isn't in Safari, so fall back to a short timeout - the
 * point is only to get off the critical path, not to be precise about when.
 */
function whenIdle(fn, timeoutMs) {
  const idle = () => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: timeoutMs || 1500 });
    } else {
      setTimeout(fn, 200);
    }
  };
  setTimeout(() => {
    const critical = window.__criticalReady;
    if (critical && typeof critical.then === 'function') {
      critical.then(idle, idle);
    } else {
      idle();
    }
  }, 0);
}

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
    // Release the space the markup reserved for this list (see
    // .is-reserving-space in styles.css). The class is set in the HTML, not
    // added here: adding it after first paint would itself be a layout shift,
    // which is what it exists to prevent. Every caller calls stop() and
    // renders in the same task, so the release and the fill land together.
    el.classList.remove('is-reserving-space');
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
function showOrderSentPopup(message, ms, opts) {
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
    // The green tick means "done". A popup that says the seller has no
    // WhatsApp is not a success, so it asks for the plain variant - and the
    // class is toggled, not just added, because this overlay is created once
    // and reused for every popup on the page.
    overlay.classList.toggle('order-sent-popup--plain', !!(opts && opts.icon === false));
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

/**
 * escapeHtml for a value going inside an HTML *attribute*.
 *
 * textContent -> innerHTML escapes &, < and >, but NOT quotes - which is
 * exactly what an attribute needs escaped. A seller-entered value dropped into
 * href="..." with only escapeHtml could close the quote and add an attribute of
 * its own, so anything interpolated into an attribute goes through this.
 */
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
/**
 * A srcset for a card photo, so the browser picks a width for the device
 * instead of every device downloading one.
 *
 * Before this, every card requested IMG_W.card (520px) whatever it was drawn
 * into. Measured slot widths: Browse tiles ~173 CSS px (three across at 390px)
 * and store cards ~186 px, which at DPR 2 need ~350-372 px - so a phone was
 * fetching roughly 1.4x more pixels than it could show, and a DPR-1 phone
 * nearly 3x.
 *
 * The widths below bracket the real slots rather than being round numbers:
 * 200 covers a DPR-1 tile, 400 a DPR-2 tile, 520 keeps the previous quality
 * ceiling for a wide desktop card so nothing gets softer than it is today.
 *
 * Returns '' when the URL is not one the optimizer can resize (an unrecognised
 * host comes back unchanged from optimizedImageUrl, and three identical URLs
 * in a srcset would just be noise) - callers omit the attribute entirely then.
 */
const IMG_SRCSET_WIDTHS = [200, 400, 520];

function imageSrcset(url, widths) {
  if (!url || typeof url !== 'string') return '';
  const list = widths || IMG_SRCSET_WIDTHS;
  const first = optimizedImageUrl(url, list[0]);
  // Unresizable host: optimizedImageUrl hands the URL straight back.
  if (first === url) return '';
  return list.map((w) => `${optimizedImageUrl(url, w)} ${w}w`).join(', ');
}

/**
 * The `sizes` hint that tells the browser how wide the slot will be BEFORE
 * layout, which is what makes srcset useful at all. Mirrors the real grids:
 * three across on a phone for Browse tiles, two across for product cards, and
 * a fixed-ish column on a wide screen.
 */
const IMG_SIZES_CARD = '(max-width: 700px) 45vw, 300px';
const IMG_SIZES_TILE = '(max-width: 700px) 31vw, 220px';

function srcsetAttr(url, sizes) {
  const set = imageSrcset(url);
  if (!set) return '';
  return ` srcset="${escapeHtml(set)}" sizes="${escapeHtml(sizes)}"`;
}

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
/**
 * Star rating display. Returns '' when there are no reviews - a product with
 * no ratings must not render as zero stars, which reads as "rated badly"
 * rather than "not rated yet".
 *
 * The fill is a width-clipped overlay so a 4.3 shows as 4.3 stars' worth
 * rather than being rounded up into a claim the data doesn't support. The
 * numeric value and review count are always rendered as text beside the
 * stars, so the rating never depends on the glyphs or their colour alone.
 */
function renderStars(rating, count) {
  const value = Number(rating);
  const reviews = Number(count) || 0;
  if (!(value > 0) || reviews === 0) return '';

  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return `<span class="rating" role="img" aria-label="Rated ${value.toFixed(1)} out of 5 from ${reviews} review${reviews === 1 ? '' : 's'}">
      <span class="rating-stars" aria-hidden="true">
        <span class="rating-stars-empty">\u2605\u2605\u2605\u2605\u2605</span>
        <span class="rating-stars-fill" style="width:${pct}%">\u2605\u2605\u2605\u2605\u2605</span>
      </span>
      <span class="rating-value">${value.toFixed(1)}</span>
      <span class="rating-count">(${reviews})</span>
    </span>`;
}

/**
 * opts.showLocation switches the card to the homepage/search treatment: the
 * price sits in the heading beside the name at the same size, and the line
 * beneath names WHERE the thing is rather than who sells it. In Kiribati the
 * island - or the village, on South Tarawa - is what tells a shopper whether
 * getting it to them is practical at all, which the store's name does not.
 *
 * The store's phone goes with the store name; a number on its own belongs to
 * nobody. Delivery icons stay either way. The Tips page and a store's
 * similar-products row keep the original card, where the seller is the point.
 */
function renderBrowseProductCard(product, opts) {
  opts = opts || {};
  const cardClass = opts.cardClass || '';
  const showLocation = !!opts.showLocation;

  const media = product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(optimizedImageUrl(product.imageUrl, IMG_W.card))}"${srcsetAttr(product.imageUrl, IMG_SIZES_CARD)} alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`
    : `<div class="placeholder-swatch category-${escapeHtml(categoryIdOf(product.category))}" aria-hidden="true">${escapeHtml(initials(product.name))}</div>`;

  const priceText = formatPriceLabel(product.variants);
  const location = storeLocationLabel(product.storeIsland, product.storeVillage);

  // Price inside the heading, at the name's size. Normal inline flow, not a
  // flex row: it puts the price beside the name and lets it fall to the next
  // line by itself when both won't fit, which is what was asked for.
  const heading = showLocation
    ? `<h3 class="product-name product-name--with-price">${escapeHtml(product.name)} <span class="product-price product-price--inline">${priceText}</span></h3>`
    : `<h3 class="product-name">${escapeHtml(product.name)}</h3>
        <strong class="product-price">${priceText}</strong>`;

  // Falls back to the store name if this store has no location recorded, so
  // the line is never blank.
  const meta = showLocation ? (location || product.storeName) : product.storeName;

  // Delivery flags are store-wide, so they are meaningless - and misleading -
  // on a rental or service listing. Suppressed there; the goods listings and
  // the store page keep them.
  const deliveryIcons = isBookingListing(product)
    ? ''
    : renderDeliveryIcons({
        truck: product.storeDeliveryTruck,
        ship: product.storeDeliveryShip,
        airCargo: product.storeDeliveryAirCargo,
        pickPay: product.storeDeliveryPickPay,
        truckCost: product.storeDeliveryTruckCost,
        shipCost: product.storeDeliveryShipCost,
        airCargoCost: product.storeDeliveryAirCargoCost
      });

  // On the location cards the icons run straight on from the place name, one
  // line instead of two, with the icons shrunk so both fit on a half-width
  // phone card (.product-card-meta in styles.css). The other surfaces keep the
  // store name on its own line with the phone and icons beneath, where there
  // is more to fit.
  const metaBlock = showLocation
    ? `<p class="helper-text product-card-meta">${escapeHtml(meta)}${deliveryIcons ? ' ' + deliveryIcons : ''}</p>`
    : `<p class="helper-text">${escapeHtml(meta)}</p>
        <div class="store-phone-row">
          ${product.storePhone ? `<span class="store-phone">${escapeHtml(product.storePhone)}</span>` : ''}
          ${deliveryIcons}
        </div>`;

  return `
    <a class="product-card${cardClass ? ' ' + cardClass : ''}" data-product-id="${escapeHtml(product.productId)}" href="product.html?store=${encodeURIComponent(product.storeSlug)}&product=${encodeURIComponent(product.productId)}" aria-label="${escapeHtml(product.name)}, ${escapeHtml(product.storeName)}">
      ${media}
      <div class="product-card-body">
        ${heading}
        ${renderStars(product.rating, product.reviewCount)}
        ${metaBlock}
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
  whenIdle(() => Api.post('recordProductViews', { productIds: newIds }).catch(() => {}));
}

// Same idea as recordProductViewsOnce, for a single store visit.
function recordStoreVisitOnce(storeSlug) {
  if (!storeSlug) return;
  const seen = getLocalIdSet('skiri_visited_stores');
  if (seen.has(storeSlug)) return;
  seen.add(storeSlug);
  saveLocalIdSet('skiri_visited_stores', seen);
  whenIdle(() => Api.post('recordStoreVisit', { storeSlug }).catch(() => {}));
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
/* ===================== Categories and listing types =====================
 *
 * TWO INDEPENDENT AXES. A category says WHAT a thing is; a listing type says
 * HOW you get it. "Vehicles & Transport" holds cars to buy, cars to rent and
 * mechanics to hire - one category, three listing types - which is why there
 * is no "Rentals" category in the list below.
 *
 * That split is new. Before it, the category WAS the type: a listing filed
 * under 'rentals' or 'services' got the date-request flow and everything else
 * went to the cart (see BOOKING_CATEGORIES). Those stored values still exist
 * on live products, so nothing here rewrites them - legacyCategoryId() and
 * listingTypeOf() map an old row to the new pair on read. A product row is
 * only ever written with new values when a seller saves it.
 *
 * `types` lists which listing types make sense in a category, used to keep the
 * seller's form short. It is guidance, not a constraint the backend enforces.
 * `popular` is the small set the homepage shows before "View all categories".
 */
const LISTING_TYPES = [
  { id: 'product', label: 'Products', seller: 'Something to sell', order: 1 },
  { id: 'rental',  label: 'Rentals',  seller: 'Something to rent out', order: 2 },
  { id: 'service', label: 'Services', seller: 'A service to offer', order: 3 }
];

const ALL_TYPES = ['product', 'rental', 'service'];

const CATEGORIES = [
  { id: 'food',        label: 'Food & Groceries',            order: 1,  popular: true,  active: true, types: ['product', 'service'] },
  { id: 'fashion',     label: 'Fashion & Beauty',            order: 2,  popular: true,  active: true, types: ['product', 'service'] },
  { id: 'electronics', label: 'Electronics & Phones',        order: 3,  popular: true,  active: true, types: ALL_TYPES },
  { id: 'home',        label: 'Home & Living',               order: 4,  popular: true,  active: true, types: ALL_TYPES },
  { id: 'building',    label: 'Building & Hardware',         order: 5,  popular: false, active: true, types: ALL_TYPES },
  { id: 'vehicles',    label: 'Vehicles & Transport',        order: 6,  popular: true,  active: true, types: ALL_TYPES },
  { id: 'fishing',     label: 'Fishing & Marine',            order: 7,  popular: false, active: true, types: ALL_TYPES },
  { id: 'agriculture', label: 'Agriculture & Local Products', order: 8, popular: false, active: true, types: ['product', 'service'] },
  { id: 'property',    label: 'Property & Accommodation',    order: 9,  popular: false, active: true, types: ['rental', 'service'] },
  { id: 'services',    label: 'Services',                    order: 10, popular: true,  active: true, types: ['service'] },
  { id: 'education',   label: 'Education & Jobs',            order: 11, popular: false, active: true, types: ['service'] },
  { id: 'events',      label: 'Events & Travel',             order: 12, popular: false, active: true, types: ALL_TYPES },
  // Always last, always offered to sellers, and where anything that cannot be
  // mapped confidently lands. Never 'popular'.
  { id: 'other',       label: 'Other',                       order: 99, popular: false, active: true, types: ALL_TYPES }
];

/**
 * Old stored category -> new category id.
 *
 * 'rentals' and 'services' were listing types wearing a category's clothes.
 * 'services' happens to name a real category too, so it keeps its slug and a
 * legacy service lands somewhere sensible. 'rentals' does not: knowing a thing
 * was rented says nothing about WHAT it is, so those go to 'other' for an admin
 * to re-file, exactly like 'general'. Their listing type is still recovered
 * correctly by listingTypeOf(), so they keep working meanwhile.
 */
const LEGACY_CATEGORY_MAP = {
  pantry: 'food',
  clothing: 'fashion',
  household: 'home',
  electronics: 'electronics',
  services: 'services',
  rentals: 'other',
  general: 'other',
  '': 'other'
};

// Which legacy values carry no category information and want an admin's eye.
const LEGACY_NEEDS_REVIEW = ['rentals', 'general', ''];

function categoryById(id) {
  return CATEGORIES.filter((c) => c.id === id)[0] || null;
}

function activeCategories() {
  return CATEGORIES.filter((c) => c.active).sort((a, b) => a.order - b.order);
}

function popularCategories() {
  return activeCategories().filter((c) => c.popular);
}

/** New id if it already is one, else the mapped legacy id, else 'other'. */
function categoryIdOf(rawCategory) {
  const raw = String(rawCategory == null ? '' : rawCategory).trim();
  if (categoryById(raw)) return raw;
  return LEGACY_CATEGORY_MAP[raw] || 'other';
}

function categoryLabelOf(rawCategory) {
  const c = categoryById(categoryIdOf(rawCategory));
  return c ? c.label : 'Other';
}

/**
 * The listing type of a product row.
 *
 * An explicit listingType always wins - that is what a seller chose. Only a row
 * saved before the field existed falls back to reading it out of the legacy
 * category, which is the ONLY thing those rows recorded about it.
 */
function listingTypeOf(product) {
  if (!product) return 'product';
  const explicit = String(product.listingType || '').trim();
  if (ALL_TYPES.indexOf(explicit) !== -1) return explicit;
  const legacy = String(product.category == null ? '' : product.category).trim();
  if (legacy === 'rentals') return 'rental';
  if (legacy === 'services') return 'service';
  return 'product';
}

/** Rentals and services are requested by date; products go in the cart. */
function isBookingListing(product) {
  return listingTypeOf(product) !== 'product';
}

/**
 * The category row is a fixed list that never depends on the backend. Its
 * height is reserved in CSS (.category-buttons min-height) so filling it in
 * doesn't push the page down.
 *
 * Returns silently if the container isn't on this page.
 */
function renderCategoryButtons(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = popularCategories().map(
    (c) => `<a class="btn category-btn category-btn--${c.id}" href="search.html?category=${encodeURIComponent(c.id)}">${escapeHtml(c.label)}</a>`
  ).join('');
}

/**
 * The [ All | Products | Rentals | Services ] strip.
 *
 * A filter on WHAT KIND of listing, which is a different question from what
 * category it is in - a shopper after "something to rent" does not know or care
 * which category the thing lives in. Rendered as links, not buttons, so each
 * one is shareable, opens in a new tab, and works before any script has run.
 *
 * `activeType` is '' for All. Returns silently if the container is absent.
 */
function renderListingTypeStrip(containerId, activeType, opts) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const active = String(activeType || '');
  const base = (opts && opts.href) || 'search.html';
  const extra = (opts && opts.extraParams) || {};
  const link = (type, label) => {
    const params = new URLSearchParams();
    Object.entries(extra).forEach(([k, v]) => { if (v) params.set(k, v); });
    if (type) params.set('type', type);
    const qs = params.toString();
    const on = active === type;
    return `<a class="chip-strip-item${on ? ' is-active' : ''}" href="${base}${qs ? '?' + qs : ''}"` +
      `${on ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  };
  container.innerHTML = link('', 'All') + LISTING_TYPES.map((t) => link(t.id, t.label)).join('');
}

/**
 * A horizontally scrolling category strip.
 *
 * Only the popular few by default, with a "View all categories" link at the
 * end - twelve full-width cards would eat the whole first screen, and the point
 * of the strip is that a shopper can see products without scrolling past it.
 *
 * `opts.all` renders every active category instead (the browse page's own bar).
 * `opts.activeId` marks one as selected.
 */
function renderCategoryStrip(containerId, opts) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const o = opts || {};
  const list = o.all ? activeCategories() : popularCategories();
  const activeId = String(o.activeId || '');
  const hrefFor = (id) => (o.hrefFor ? o.hrefFor(id) : `search.html?category=${encodeURIComponent(id)}`);

  const items = list.map((c) => {
    const on = c.id === activeId;
    return `<a class="chip-strip-item${on ? ' is-active' : ''}" data-category="${escapeHtml(c.id)}"` +
      ` href="${hrefFor(c.id)}"${on ? ' aria-current="page"' : ''}>${escapeHtml(c.label)}</a>`;
  });

  if (!o.all) {
    items.push('<a class="chip-strip-item chip-strip-item--more" href="categories.html">View all categories →</a>');
  }
  container.innerHTML = items.join('');
}

// Kept in sync with apps-script/Products.gs's BOOKING_CATEGORIES - a
// Rentals/Services listing gets the date-range request flow instead of
// cart/checkout.
// LEGACY. The old way of saying "booked by date". Still the stored value on
// rows saved before listingType existed, which is why listingTypeOf() reads
// them - but a legacy rental's MAPPED category is now 'other', so this returns
// false for exactly the listings it used to catch. Use isBookingListing().
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
/**
 * Does this store have any delivery method whose fee is not set?
 *
 * null is the wire form of "to be negotiated" (deliveryCostOf in Products.gs);
 * 0 is genuinely free. Pick & Pay is always free, so it never counts - there
 * is nothing to negotiate about collecting it yourself.
 *
 * Takes a listProducts response, which is what both pages that need it have.
 */
function storeHasNegotiatedDelivery(res) {
  if (!res) return false;
  return [
    [res.storeDeliveryTruck, res.storeDeliveryTruckCost],
    [res.storeDeliveryShip, res.storeDeliveryShipCost],
    [res.storeDeliveryAirCargo, res.storeDeliveryAirCargoCost]
  ].some(function (pair) { return pair[0] && pair[1] == null; });
}

/**
 * Fills in the once-per-page negotiated-shipping line, or leaves it hidden.
 *
 * This sentence used to be printed on EVERY product card, unconditionally - so
 * a store with a fixed $5 truck fee still told shoppers the fee was to be
 * negotiated, ten times down the page. Said once, and only when true.
 */
function renderShippingNote(elementId, res) {
  const noteEl = document.getElementById(elementId);
  if (!noteEl) return;
  if (!storeHasNegotiatedDelivery(res)) return;
  noteEl.textContent = 'Shipping fee and delivery date to be negotiated — chat with this store for details.';
  noteEl.hidden = false;
}

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

// Inline like every other icon here: no icon library, no extra request. Drawn
// in the same 24-box, single-stroke style as the phone and messenger glyphs so
// the three buttons sit together as a set.
const WHATSAPP_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path><path d="M8.5 10.5c.5 2 2.5 4 4.5 4.5l1.2-1.2 2 .9v1.6c-2.6.4-6.2-2.2-7.4-5.4l1.4-1.2z"></path></svg>';

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

/* ===================== Seller contact buttons =====================
 *
 * Call / WhatsApp / Messenger, shown once a customer has sent a booking
 * request or placed an order. Waiting on a vendor should not mean having no way
 * to reach them.
 *
 * ALL THREE ARE ALWAYS SHOWN, even when the seller has not given that contact
 * method. Hiding the missing ones - what the store page used to do - leaves the
 * customer wondering whether the seller has no WhatsApp or whether Mwakete is
 * broken. Tapping an unavailable one says so plainly instead.
 */

// Kiribati first, English under it. The WhatsApp line is the wording the site
// owner gave; the other two follow its pattern.
const NO_CONTACT_MESSAGES = {
  call: 'Akea ana namba te seller aio — this seller has no phone number.',
  whatsapp: 'Akea ana WhatsApp te seller aio — this seller has no WhatsApp.',
  messenger: 'Akea ana Messenger te seller aio — this seller has no Messenger.'
};

/**
 * wa.me needs a full international number with no plus and no punctuation.
 *
 * This is the part that would quietly break: a Kiribati number is stored as
 * eight local digits (73007552), and wa.me/73007552 is not a real number
 * anywhere - the link would open WhatsApp on an error rather than the seller.
 * classifyKiribatiPhone already knows whether a number is local, so a local one
 * gets Kiribati's 686 prefix and an overseas one is passed through as dialled.
 */
function whatsappUrl(number) {
  const raw = String(number || '').trim();
  if (!raw) return '';
  const parsed = classifyKiribatiPhone(raw);
  const digits = String(parsed.national || '').replace(/\D/g, '');
  if (!digits) return '';
  return 'https://wa.me/' + (parsed.local ? '686' + digits : digits);
}

/**
 * The three buttons, from whatever the store actually has.
 *
 * `contacts` is { phone, whatsapp, messenger }. WhatsApp falls back to the
 * contact phone when the seller has not set a separate one, which is what makes
 * this work for every existing seller on day one - most people's WhatsApp is
 * their phone number, and asking them all to re-enter it would mean the button
 * said "no WhatsApp" for the whole marketplace until they did.
 */
function sellerContactButtons(contacts) {
  const c = contacts || {};
  const phone = String(c.phone || '').trim();
  const whatsapp = String(c.whatsapp || '').trim() || phone;
  const messenger = String(c.messenger || '').trim();

  const btn = (kind, href, icon, label) => (href
    ? `<a class="btn btn-${kind}" href="${escapeAttr(href)}"${kind === 'call' ? '' : ' target="_blank" rel="noopener"'}>${icon}${label}</a>`
    : `<button type="button" class="btn btn-${kind} is-unavailable" data-no-contact="${kind}">${icon}${label}</button>`);

  return [
    btn('call', phone ? 'tel:' + phone : '', PHONE_ICON_SVG, 'Call'),
    btn('whatsapp', whatsappUrl(whatsapp), WHATSAPP_ICON_SVG, 'WhatsApp'),
    btn('messenger', messengerUrl(messenger), MESSENGER_ICON_SVG, 'Messenger')
  ].join('');
}

/**
 * One delegated listener per page for every unavailable-contact button.
 *
 * Delegated on document rather than bound per button because these blocks are
 * rendered after an async response, sometimes more than once on the store page
 * (one per booking card), and re-binding on each render is how duplicate
 * handlers accumulate.
 */
function wireContactUnavailable() {
  if (window.__contactUnavailableWired) return;
  window.__contactUnavailableWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-no-contact]');
    if (!btn) return;
    e.preventDefault();
    const msg = NO_CONTACT_MESSAGES[btn.dataset.noContact];
    if (msg) showOrderSentPopup(msg, 2600, { icon: false });
  });
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
