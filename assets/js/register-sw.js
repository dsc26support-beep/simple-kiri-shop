// Registers the service worker (sw.js), which lives at the site root.
//
// The 14 pages sit at two depths - root (index.html) and owner/ (login.html) -
// and this script is included with different relative prefixes on each, so a
// plain register('sw.js') would resolve to owner/sw.js on the owner pages and
// fail. Instead we derive the SW URL from THIS script's own location: it always
// lives at assets/js/register-sw.js, so ../../sw.js is the site root regardless
// of which page loaded it.
//
// document.currentScript is only valid while the script is first parsed (it's
// null inside the later load handler), so capture the script URL now.
(function () {
  var scriptUrl = (document.currentScript && document.currentScript.src) || location.href;

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    var swUrl = new URL('../../sw.js', scriptUrl).href;
    // Fail silently - a missing or blocked service worker must never break the
    // page; the site works fine without it, just without offline caching.
    navigator.serviceWorker.register(swUrl).catch(function () {});
  });
})();
