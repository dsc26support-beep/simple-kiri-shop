// Welcome screen on customer-login.html (owner request, Nov 2026, inspired by
// Billdu's sign-up page): the live store and product counts. English only
// since 11 Nov 2026 (owner: the English / Kiribati switch was removed).
//
// Shown when html.welcome-on is set (decided in the page's <head>): a plain
// visit to the sign-in page, or a first visit to the homepage (index.html
// sends those here once with ?welcome=1).
(function () {
  'use strict';

  var stats = null;

  function count(n, one, many) {
    return Number(n).toLocaleString('en') + ' ' + (Number(n) === 1 ? one : many);
  }

  // Only real numbers: nothing is shown until the backend answers (or a
  // previous answer kept on this phone), and nothing if it fails.
  function drawStats() {
    var el = document.getElementById('welcome-stats');
    if (!el) return;
    if (!stats || !(stats.stores > 0)) { el.textContent = ''; el.classList.remove('is-ready'); return; }
    var parts = [count(stats.stores, 'store', 'stores')];
    if (stats.products > 0) parts.push(count(stats.products, 'product', 'products'));
    el.textContent = parts.join(' · ');
    el.classList.add('is-ready');
  }

  function loadStats() {
    if (typeof Api === 'undefined') return;
    var kept = Api.recall('siteStats');
    if (kept) { stats = kept; drawStats(); }
    var call;
    try { call = Api.get('siteStats'); } catch (e) { return; }
    call.then(function (res) {
      if (!res || !res.ok || typeof res.stores !== 'number') return;
      stats = { stores: res.stores, products: Number(res.products) || 0 };
      Api.remember('siteStats', stats);
      drawStats();
    }).catch(function () { /* the line just stays empty */ });
  }

  function init() {
    // The language choice the switch used to remember is no longer used.
    try { localStorage.removeItem('mwk_lang'); } catch (e) { /* nothing to tidy */ }
    if (document.documentElement.classList.contains('welcome-on')) loadStats();
  }

  if (document.readyState === 'complete') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
