// Service worker for the standalone Mwakete POS (pos/). Oct 2026.
//
// Its job: the till opens and sells with no connection. So the app shell (this
// page, the POS scripts and styles) is cached on install, and pages are served
// from the network when possible and from the cache when not.
//
// It NEVER caches the backend (the Apps Script URL): sales, stock and prices
// must come fresh from Mwakete. The till keeps its own data in IndexedDB
// (assets/js/pos-db.js), not here - a cache is not a database.
//
// Bump CACHE whenever a file below changes. Only caches named mwakete-pos-*
// are this worker's; the site's main worker (../sw.js) leaves them alone.
var CACHE = 'mwakete-pos-v2';
var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  '../assets/css/styles.min.css',
  '../assets/css/pos.min.css',
  '../assets/img/favicon.svg',
  '../assets/img/app-icon-192.png',
  '../assets/js/config.min.js',
  '../assets/js/api.min.js',
  '../assets/js/helpers.min.js',
  '../assets/js/auth.min.js',
  '../assets/js/product-options.min.js',
  '../assets/js/pos-core.min.js',
  '../assets/js/pos-db.min.js',
  '../assets/js/pos-sync.min.js',
  '../assets/js/pos-camera.min.js',
  '../assets/js/pos-app.min.js',
  '../assets/js/pos-standalone.min.js'
];
// The camera scanner library (free, MIT), kept once fetched so the camera works offline too.
var CDN_OK = ['https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(SHELL.map(function (url) { return cache.add(url).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (key) {
      return key.indexOf('mwakete-pos-') === 0 && key !== CACHE ? caches.delete(key) : null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (CDN_OK.some(function (p) { return req.url.indexOf(p) === 0; })) {
      event.respondWith(caches.open(CACHE).then(function (c) {
        return c.match(req).then(function (hit) {
          return hit || fetch(req).then(function (res) { if (res.ok) c.put(req, res.clone()); return res; });
        });
      }));
    }
    return; // the backend and everything else: network only
  }
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('index.html', copy); });
      return res;
    }).catch(function () {
      return caches.match('index.html').then(function (hit) { return hit || caches.match('./'); });
    }));
    return;
  }
  // Scripts, styles, icons: from the cache at once, refreshed in the background.
  event.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res.ok) c.put(req, res.clone()); return res; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
