// Welcome screen on customer-login.html (owner request, Nov 2026, inspired by
// Billdu's sign-up page): live store and product counts, an English / Kiribati
// switch for the welcome text, and "Add Mwakete to your home screen".
//
// Shown when html.welcome-on is set (decided in the page's <head>): a plain
// visit to the sign-in page, or a first visit to the homepage (index.html
// sends those here once with ?welcome=1).
(function () {
  'use strict';

  var LANG_KEY = 'mwk_lang';

  // The Kiribati is a DRAFT (Nov 2026) for a Kiribati speaker to check.
  // Corrections go here only - every welcome line reads from this table.
  var TEXT = {
    en: {
      title: 'Shop Kiribati’s stores',
      sub: 'Order from local stores across Kiribati, all in one place.',
      stores: 'stores',
      store: 'store',
      products: 'products',
      product: 'product',
      guestQ: 'Just looking?',
      guest: 'Browse as a guest',
      sellQ: 'Own a store?',
      sell: 'Sell on Mwakete',
      install: 'Add Mwakete to your home screen',
      close: 'Close'
    },
    gil: {
      title: 'Kaboo man titoa ni Kiribati',
      sub: 'Kaboo bwaai man titoa aika iaon Kiribati ni kabane, n te tabo ae teuana.',
      stores: 'titoa',
      store: 'titoa',
      products: 'bwaai',
      product: 'bwai',
      guestQ: 'Ko tii tarataraa?',
      guest: 'Tarataraa n te iruwa',
      sellQ: 'Iai am titoa?',
      sell: 'Kaboonako i Mwakete',
      install: 'Katokaa Mwakete i aon am tareboon',
      close: 'Kaina'
    }
  };

  var lang = 'en';
  var stats = null;

  function $(id) { return document.getElementById(id); }

  function savedLang() {
    try { return localStorage.getItem(LANG_KEY) === 'gil' ? 'gil' : 'en'; } catch (e) { return 'en'; }
  }

  function setLang(next) {
    lang = TEXT[next] ? next : 'en';
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* not remembered */ }
    var t = TEXT[lang];
    document.querySelectorAll('[data-wl]').forEach(function (el) {
      var key = el.getAttribute('data-wl');
      if (t[key] != null) el.textContent = t[key];
    });
    document.querySelectorAll('[data-wl-label]').forEach(function (el) {
      var key = el.getAttribute('data-wl-label');
      if (t[key] != null) el.setAttribute('aria-label', t[key]);
    });
    var hero = $('welcome-hero');
    if (hero) hero.setAttribute('lang', lang === 'gil' ? 'gil' : 'en');
    document.querySelectorAll('.welcome-lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });
    drawStats();
  }

  function count(n, one, many) {
    return Number(n).toLocaleString('en') + ' ' + (Number(n) === 1 ? one : many);
  }

  // Only real numbers: nothing is shown until the backend answers (or a
  // previous answer kept on this phone), and nothing if it fails.
  function drawStats() {
    var el = $('welcome-stats');
    if (!el) return;
    if (!stats || !(stats.stores > 0)) { el.textContent = ''; el.classList.remove('is-ready'); return; }
    var t = TEXT[lang];
    var parts = [count(stats.stores, t.store, t.stores)];
    if (stats.products > 0) parts.push(count(stats.products, t.product, t.products));
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

  function wireInstall() {
    var row = $('welcome-install');
    var btn = $('welcome-install-btn');
    if (!row || !btn || !window.MwaketeInstall) return;
    btn.addEventListener('click', function () { window.MwaketeInstall.install(); });
    window.MwaketeInstall.onChange(function (can) { row.hidden = !can; });
  }

  function init() {
    var on = document.documentElement.classList.contains('welcome-on');
    document.querySelectorAll('.welcome-lang button').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); });
    });
    setLang(savedLang());
    wireInstall();
    if (on) loadStats();
  }

  // After every deferred script (register-sw.js, which offers the
  // home-screen prompt, loads after this one).
  if (document.readyState === 'complete') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
