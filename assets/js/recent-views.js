/**
 * Recently viewed products and stores - kept on THIS device only.
 *
 * A product counts when its product page is opened; a store when its store
 * page is opened (not when a card merely scrolls past). Each list keeps the
 * newest RECENT_VIEWS_MAX, newest first, one entry per product / store.
 *
 * Nothing is sent to Mwakete: this is the "which stores and products you
 * have looked at, used to show you recently viewed items" line in the
 * Privacy Policy, and clearing browser data (or Clear history on
 * recent.html) deletes it.
 *
 * Only what a list row needs is kept - name, photo, store, place - and NOT
 * prices or stock, which go stale. The row links to the live page, which
 * shows the current price.
 */
const RECENT_VIEWS_MAX = 30;
const RECENT_PRODUCTS_KEY = 'skiri_recent_products';
const RECENT_STORES_KEY = 'skiri_recent_stores';

function readRecent(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    // Anything malformed (an old shape, a hand-edited value) is dropped
    // rather than allowed to break the page that reads it.
    return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object' && e.id) : [];
  } catch (e) {
    return [];
  }
}

function writeRecent(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, RECENT_VIEWS_MAX)));
  } catch (e) {
    // storage full or blocked (private mode) - history is a nicety, never an error
  }
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function pushRecent(key, entry) {
  const list = readRecent(key).filter((e) => e.id !== entry.id);
  list.unshift(entry);
  writeRecent(key, list);
}

/** product: the product object from listProducts; res: that response (store fields). */
function recordRecentProduct(product, storeSlug, res) {
  if (!product || !product.productId || !storeSlug) return;
  res = res || {};
  pushRecent(RECENT_PRODUCTS_KEY, {
    id: clip(product.productId, 80),
    storeSlug: clip(storeSlug, 120),
    name: clip(product.name, 200),
    imageUrl: clip(product.imageUrl, 1000),
    listingType: clip(product.listingType, 20),
    storeName: clip(res.storeName, 200),
    island: clip(res.storeIsland, 100),
    village: clip(res.storeVillage, 100),
    at: Date.now()
  });
}

/** res: the listProducts response for that store. */
function recordRecentStore(storeSlug, res) {
  if (!storeSlug || !res) return;
  pushRecent(RECENT_STORES_KEY, {
    id: clip(storeSlug, 120),
    name: clip(res.storeName, 200),
    logoUrl: clip(res.storeLogoUrl, 1000),
    island: clip(res.storeIsland, 100),
    village: clip(res.storeVillage, 100),
    at: Date.now()
  });
}

function getRecentProducts() { return readRecent(RECENT_PRODUCTS_KEY); }
function getRecentStores() { return readRecent(RECENT_STORES_KEY); }

function clearRecentViews() {
  try {
    localStorage.removeItem(RECENT_PRODUCTS_KEY);
    localStorage.removeItem(RECENT_STORES_KEY);
  } catch (e) { /* nothing to clear */ }
}
