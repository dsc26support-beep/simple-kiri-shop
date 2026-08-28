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

// ---------------------------------------------------------------------------
// Custom "Install" button (mobile & tablet only).
//
// Instead of leaving install to the browser's fleeting native prompt, we
// suppress that prompt (preventDefault on beforeinstallprompt), stash it, and
// surface our own small Install pill in the lower-right, just above the chat
// FAB. It shows on every page load while the app isn't installed, and hides
// itself after a minute. On Android Chromium the button fires the real install
// prompt; on iOS (no programmatic install) it shows Add-to-Home-Screen
// instructions. Kept independent of the service-worker block above so it still
// works where SW is unavailable.
// ---------------------------------------------------------------------------
(function () {
  var HIDE_MS = typeof window.MWAKETE_INSTALL_HIDE_MS === 'number' ? window.MWAKETE_INSTALL_HIDE_MS : 60000;
  var CHAT_FAB_HEIGHT = 56; // keep in sync with .chat-fab-btn height in styles.css

  var INSTALLED_KEY = 'skiri_pwa_installed';

  var deferredPrompt = null;
  // Remember a prior install so the button stays hidden on later browser reloads,
  // not just for the session where appinstalled fired.
  var installed = false;
  try { installed = localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) {}
  var btn = null;
  var hint = null;
  var hideTimer = null;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function isMobileOrTablet() {
    return window.matchMedia && window.matchMedia('(max-width: 1024px)').matches;
  }

  function isIos() {
    var ua = window.navigator.userAgent || '';
    if (/iphone|ipad|ipod/i.test(ua)) return true;
    // iPadOS 13+ reports as "Macintosh" but is a touch device.
    return /Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1;
  }

  function removeHint() {
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    hint = null;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(e) {
    if (hint && e.target !== hint && !hint.contains(e.target) && e.target !== btn) removeHint();
  }

  function showHint(text) {
    removeHint();
    hint = document.createElement('div');
    hint.className = 'install-hint';
    hint.textContent = text;
    document.body.appendChild(hint);
    // Defer so the same click that opened it doesn't immediately close it.
    setTimeout(function () { document.addEventListener('click', onOutsideClick, true); }, 0);
  }

  function hideButton() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (btn) btn.classList.remove('is-visible');
    removeHint();
  }

  function onInstallClick() {
    if (deferredPrompt) {
      var dp = deferredPrompt;
      deferredPrompt = null; // single-use
      dp.prompt();
      dp.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') hideButton();
      }).catch(function () {});
      return;
    }
    if (isIos()) {
      showHint("Tap the Share button, then 'Add to Home Screen'.");
      return;
    }
    showHint("Open your browser menu and choose 'Install app' / 'Add to Home screen'.");
  }

  function buildButton() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'install-fab';
    btn.setAttribute('aria-label', 'Install this app');
    btn.style.setProperty('--chat-fab-height', CHAT_FAB_HEIGHT + 'px');
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>' +
      '<span>Install</span>';
    btn.addEventListener('click', onInstallClick);
    document.body.appendChild(btn);
    return btn;
  }

  function showButton() {
    if (installed || isStandalone() || !isMobileOrTablet()) return;
    buildButton().classList.add('is-visible');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideButton, HIDE_MS);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // suppress the native infobar - our button replaces it
    deferredPrompt = e;
    // This event only fires when the app is NOT installed, so if a stale
    // "installed" flag is set (e.g. the user uninstalled), clear it and let the
    // button return.
    installed = false;
    try { localStorage.removeItem(INSTALLED_KEY); } catch (err) {}
    showButton();
  });

  window.addEventListener('appinstalled', function () {
    installed = true;
    deferredPrompt = null;
    try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (err) {}
    hideButton();
  });

  // On Chromium the button is shown by the beforeinstallprompt handler above,
  // which only fires when the app is installable AND not installed - so once
  // installed it never reappears in the browser. iOS never fires that event but
  // can still add-to-home-screen, so show the button there on load instead.
  window.addEventListener('load', function () {
    if (isIos()) showButton();
  });
})();
