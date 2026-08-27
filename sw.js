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

var CACHE = 'mwakete-v1';

// The app shell we pre-cache on install so the very first offline load still
// has something to show. Paths are relative to the SW's scope (site root),
// which works whether the site is served from a domain root or a project
// subpath like /simple-kiri-shop/.
var PRECACHE = [
  './',
  'index.html',
  'offline.html',
  'assets/css/styles.css',
  'assets/js/config.js',
  'assets/js/api.js',
  'assets/js/helpers.js',
  'assets/img/favicon.svg'
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
          return key === CACHE ? null : caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only ever handle GETs, and only same-origin requests. Anything else -
  // the Apps Script backend, image CDNs, POSTs - goes straight to the network
  // untouched, so backend freshness is never compromised by the cache.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // HTML navigations: network-first so the user always gets the latest page
  // when online; fall back to the cached copy, then to the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (cached) {
            return cached || caches.match('offline.html');
          });
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
