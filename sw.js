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
var CACHE = 'mwakete-v9';

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
