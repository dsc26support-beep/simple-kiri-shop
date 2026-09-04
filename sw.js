// Service worker for the Mwakete PWA.
//
// This site is a static shell (HTML/CSS/JS/icons) whose data all comes from a
// remote Google Apps Script backend. The two must be treated very differently:
//
//   - Static shell  -> safe and good to cache (fast repeat loads, offline shell).
//   - Backend / API -> must NEVER be cached: orders, chat, and bookings depend
//     on fresh reads. Anything cross-origin (the Apps Script /macros/s/... URL,
//     Cloudinary images, m.me, etc.) is left entirely to the network.
//
// Because the app is meant to always reflect the live hosted site, HTML
// navigations are network-first (newest page wins), with cache and then a
// minimal offline page as fallbacks. Static assets are stale-while-revalidate
// so they load instantly but still refresh in the background.

// Bump this on any release that changes a file in PRECACHE or any other
// cached CSS/JS. Static assets are stale-while-revalidate (see the fetch
// handler), so without a bump the first load after a deploy still serves the
// PREVIOUS stylesheet and only refreshes it in the background - the change
// appears one load late, which reads as "my fix didn't ship". Renaming the
// cache makes activate() drop the old one, so the next load fetches fresh.
var CACHE = 'mwakete-v20';

// Separate cache for cross-origin product/logo photos. Cache-first is safe here
// because every uploaded image has a unique URL (Drive file id / Cloudinary
// public id both include a timestamp - see apps-script/Images.gs), so a replaced
// photo gets a brand-new URL and this never serves a stale image. Kept apart
// from the shell cache so it can be size-capped independently.
var IMG_CACHE = 'mwakete-img-v1';
var IMG_CACHE_MAX = 80;
var IMAGE_HOSTS = ['res.cloudinary.com', 'lh3.googleusercontent.com'];

// The app shell we pre-cache on install so the very first offline load still
// has something to show. Paths are relative to the SW's scope (site root),
// which works whether the site is served from a domain root or a project
// subpath like /simple-kiri-shop/.
var PRECACHE = [
  './',
  'offline.html',
  'assets/css/styles.css',
  'assets/img/favicon.svg',

  // Every customer-facing page and the scripts it needs. The whole set is
  // ~150KB and fetched once, on install, while the shopper is reading the
  // page that installed it - after which moving between pages costs no
  // network at all. That matters here more than the download does: the first
  // tap from the homepage to a store used to fetch eight scripts it had never
  // seen, over a mobile link, before anything could render.
  //
  // Owner pages are deliberately left out. There are a handful of vendors on
  // better connections, and precaching their bundle would make every shopper
  // pay for it.
  'index.html',
  'store.html',
  'product.html',
  'stores.html',
  'categories.html',
  'my-carts.html',
  'search.html',
  'cart.html',
  'checkout.html',
  'customer-tips.html',
  'customer-login.html',
  'customer-dashboard.html',
  'customer-messages.html',

  'assets/js/config.js',
  'assets/js/api.js',
  'assets/js/helpers.js',
  'assets/js/auth.js',
  'assets/js/customer-auth.js',
  'assets/js/cookie-consent.js',
  'assets/js/bottom-nav.js',
  'assets/js/header-cart.js',
  'assets/js/register-sw.js',
  'assets/js/cart.js',
  'assets/js/product-card.js',
  'assets/js/chat-window.js',
  'assets/js/kiribati-locations.js',
  'assets/js/home.js',
  'assets/js/home-nav.js',
  'assets/js/store.js',
  'assets/js/product-page.js',
  'assets/js/directory.js',
  'assets/js/categories.js',
  'assets/js/my-carts.js',
  'assets/js/search.js',
  'assets/js/cart-page.js',
  'assets/js/checkout.js',
  'assets/js/customer-login.js',
  'assets/js/customer-dashboard.js',
  'assets/js/customer-messages.js',
  'assets/js/customer-tips.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Don't let one missing/renamed asset abort the whole install.
      return Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(url).catch(function () {});
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          return (key === CACHE || key === IMG_CACHE) ? null : caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Keep the image cache from growing without bound: once it exceeds the cap,
// drop the oldest entries (cache.keys() preserves insertion order).
function trimImageCache() {
  return caches.open(IMG_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= IMG_CACHE_MAX) return;
      return Promise.all(
        keys.slice(0, keys.length - IMG_CACHE_MAX).map(function (k) { return cache.delete(k); })
      );
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;

  if (req.method !== 'GET') return;

  // Cross-origin product/logo photos: cache-first (see IMG_CACHE note above).
  // The Apps Script backend is a different host and is NOT in IMAGE_HOSTS, so it
  // stays fully bypassed below - backend freshness is never touched.
  var host = new URL(req.url).hostname;
  if (IMAGE_HOSTS.indexOf(host) !== -1) {
    event.respondWith(
      caches.open(IMG_CACHE).then(function (cache) {
        return cache.match(req).then(function (cached) {
          if (cached) return cached;
          return fetch(req).then(function (res) {
            // Cache successful and opaque (no-cors <img>) responses alike.
            if (res && (res.ok || res.type === 'opaque')) {
              cache.put(req, res.clone());
              trimImageCache();
            }
            return res;
          });
        });
      })
    );
    return;
  }

  // Everything else: only handle same-origin requests. Cross-origin (the Apps
  // Script backend, other hosts) and POSTs go straight to the network untouched,
  // so backend freshness is never compromised by the cache.
  if (new URL(req.url).origin !== self.location.origin) return;

  // HTML navigations: stale-while-revalidate, the same strategy the CSS/JS
  // below already use, because these pages are the same kind of thing - a
  // static shell. Not one byte of store, product, price or message data lives
  // in the HTML; it is all fetched at runtime from the backend, which this
  // worker never caches. So serving the shell from cache cannot show anyone a
  // stale price, and it turns every tap between pages from "wait for a round
  // trip to GitHub Pages" into an instant render.
  //
  // This was network-first before. On a fast connection the difference is
  // invisible; on a Kiribati mobile link it was the whole feel of the site.
  //
  // The cost is that a release reaches an already-installed device one
  // navigation late. That is the tradeoff already accepted for CSS and JS, and
  // it is bounded the same way: bump CACHE on release, and activate() drops
  // the old one (skipWaiting + clients.claim are already in place above), so
  // the load after that is fresh.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then(function (cached) {
        var network = fetch(req)
          .then(function (res) {
            if (res && res.status === 200) {
              var copy = res.clone();
              caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
            }
            return res;
          })
          .catch(function () {
            return cached || caches.match('offline.html');
          });
        return cached || network;
      })
    );
    return;
  }

  // Static assets (CSS/JS/icons): stale-while-revalidate - serve cache
  // immediately for speed, refresh the cache in the background.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req)
        .then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || network;
    })
  );
});
