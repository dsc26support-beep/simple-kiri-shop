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

  /* ---- keeping an INSTALLED app up to date ---------------------------------
   *
   * sw.js already calls skipWaiting() and clients.claim(), so a new build takes
   * over the moment the browser notices it. The gap this closes is that on an
   * installed app the browser may not notice for days: it only checks sw.js on
   * a navigation, and someone who leaves Mwakete resident on their phone and
   * switches back to it does not navigate. They can sit on an old build
   * indefinitely.
   *
   * So the check is explicit - once on launch, and again every time the app is
   * brought back to the foreground.
   */

  // Was this page already under a service worker when it loaded?
  //
  // This is the difference between "a NEW version took over" and "the very
  // first service worker just installed". Both fire controllerchange, and
  // reloading on the second is a pointless refresh on someone's first ever
  // visit. Captured now, before registration can change it.
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;

  /**
   * Is it safe to refresh the page out from under whoever is holding the phone?
   *
   * Everything here is a case where a reload costs the person something real
   * rather than just being startling. Getting this wrong in the permissive
   * direction means losing someone's typed delivery address or half-written
   * message; getting it wrong the other way just means they see the update bar.
   * So the bar is the fallback, always.
   */
  function safeToReload() {
    // Money. An order mid-flight is never worth interrupting for a cosmetic
    // update, whatever else is true.
    if (/checkout/i.test(location.pathname)) return false;

    // A form the unsaved-changes guard is watching and considers genuinely
    // changed. Reuses that judgement rather than inventing a second one.
    try {
      if (typeof UnsavedGuard !== 'undefined' && UnsavedGuard.isDirty()) return false;
    } catch (e) { return false; }

    // A half-written chat message lives in an input the guard does not watch.
    if (document.querySelector('.chat-window--open')) return false;

    // Someone typing at this very moment, anywhere.
    var el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|hidden)$/i.test(el.type)))) {
      return false;
    }

    // A dialog waiting on an answer.
    if (document.querySelector('.unsaved-overlay, dialog[open]')) return false;

    return true;
  }

  function applyUpdate() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  /**
   * The fallback when a refresh would cost someone their work: a centered
   * "Update available" popup (owner request, Oct 2026) with Update now /
   * Later and one line on what's new (release.json, written each release).
   *
   * It never pops up under someone's fingers: while the cursor is in a text
   * field it waits, and appears once they leave the field. Later just closes
   * it - the new build is already in control, so the next page they open is
   * the new version anyway.
   */
  var popupPending = false;

  function typing() {
    var el = document.activeElement;
    return !!(el && (el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|hidden)$/i.test(el.type))));
  }

  function whenNotTyping(fn) {
    if (!typing()) { fn(); return; }
    var onOut = function () {
      // Focus moving from one field straight into another is still typing.
      setTimeout(function () {
        if (typing()) return;
        document.removeEventListener('focusout', onOut, true);
        fn();
      }, 0);
    };
    document.addEventListener('focusout', onOut, true);
  }

  function showUpdatePopup() {
    if (popupPending || document.getElementById('app-update-popup')) return;
    popupPending = true;
    whenNotTyping(function () {
      popupPending = false;
      if (document.getElementById('app-update-popup')) return;
      var back = document.createElement('div');
      back.id = 'app-update-popup';
      back.className = 'app-update-back';
      back.innerHTML =
        '<div class="app-update-box" role="dialog" aria-modal="true" aria-labelledby="app-update-title" aria-describedby="app-update-note">'
        + '<h2 id="app-update-title" class="app-update-title">Update available</h2>'
        + '<p id="app-update-note" class="app-update-note">A new version of Mwakete is ready.</p>'
        + '<div class="app-update-actions">'
        + '<button type="button" class="btn btn-primary" id="app-update-refresh">Update now</button>'
        + '<button type="button" class="btn" id="app-update-later">Later</button>'
        + '</div></div>';
      document.body.appendChild(back);
      // Hides the install tab while this is up - see styles.css.
      document.body.classList.add('has-app-update');
      var close = function () {
        back.remove();
        document.body.classList.remove('has-app-update');
        document.removeEventListener('keydown', onKey);
      };
      var onKey = function (e) {
        if (e.key === 'Escape' || e.key === 'Esc') close();
        if (e.key === 'Tab') {
          var a = document.getElementById('app-update-refresh');
          var b = document.getElementById('app-update-later');
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
          else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener('keydown', onKey);
      document.getElementById('app-update-refresh').addEventListener('click', applyUpdate);
      document.getElementById('app-update-later').addEventListener('click', close);
      document.getElementById('app-update-refresh').focus();
      // What's new, from the NEW build (release.json at the site root). Never
      // from the HTTP cache; offline or missing keeps the plain line above.
      try {
        fetch(new URL('../../release.json', scriptUrl).href, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var note = j && typeof j.note === 'string' ? j.note.trim() : '';
            var el = document.getElementById('app-update-note');
            if (note && el) el.textContent = 'A new version of Mwakete is ready: ' + note;
          }).catch(function () {});
      } catch (e) { /* plain line stays */ }
    });
  }

  function onNewVersionReady() {
    if (!hadController) return;      // first install, not an update
    if (safeToReload()) applyUpdate();
    else showUpdatePopup();
  }

  window.addEventListener('load', function () {
    var swUrl = new URL('../../sw.js', scriptUrl).href;
    // Fail silently - a missing or blocked service worker must never break the
    // page; the site works fine without it, just without offline caching.
    navigator.serviceWorker.register(swUrl, {
      // Never answer an update check from the HTTP cache. GitHub Pages serves
      // sw.js with its own caching, and a cached copy would report "no change"
      // for as long as it lived - which is the whole bug this is fixing.
      updateViaCache: 'none'
    }).then(function (reg) {
      if (!reg) return;

      var check = function () { try { reg.update(); } catch (e) {} };

      // On launch, and again whenever the app comes back to the foreground -
      // which on an installed app is the only moment that reliably happens.
      check();
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') check();
      });
      // Android sometimes delivers pageshow rather than visibilitychange when
      // an installed app is resumed from the task switcher.
      window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });
    }).catch(function () {});

    // Fires when a different worker takes control - i.e. a new build activated.
    navigator.serviceWorker.addEventListener('controllerchange', onNewVersionReady);
  });

  /**
   * Which build is this phone actually running? Resolves to the service
   * worker's own cache name, or null when there is no worker.
   *
   * Exposed for the account page. Always resolves - a support line that hangs
   * because the worker did not answer is worse than one that says "unknown".
   */
  window.MwaketeVersion = {
    get: function () {
      return new Promise(function (resolve) {
        var sw = navigator.serviceWorker.controller;
        if (!sw) { resolve(null); return; }
        var timer = setTimeout(function () { resolve(null); }, 1500);
        try {
          var channel = new MessageChannel();
          channel.port1.onmessage = function (e) {
            clearTimeout(timer);
            resolve((e.data && e.data.version) || null);
          };
          sw.postMessage({ type: 'MWAKETE_GET_VERSION' }, [channel.port2]);
        } catch (e) {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }
  };
})();

// ---------------------------------------------------------------------------
// Custom "App Install" button (mobile & tablet only).
//
// Instead of leaving install to the browser's fleeting native prompt, we
// suppress that prompt (preventDefault on beforeinstallprompt), stash it, and
// surface our own "App Install" tab: a yellow tab on the right edge, words
// rotated to read bottom to top, floating level with the homepage's
// Categories ... Recents row (owner request, Oct 2026). It stays at that
// height on screen while the page scrolls, on every page. It shows on every page load while the app isn't installed, and hides
// itself after a minute. On Android Chromium the button fires the real install
// prompt; on iOS (no programmatic install) it shows Add-to-Home-Screen
// instructions. Kept independent of the service-worker block above so it still
// works where SW is unavailable.
// ---------------------------------------------------------------------------
(function () {
  var HIDE_MS = typeof window.MWAKETE_INSTALL_HIDE_MS === 'number' ? window.MWAKETE_INSTALL_HIDE_MS : 60000;
  var CHAT_FAB_HEIGHT = 56; // keep in sync with .chat-fab-btn height in styles.css

  var INSTALLED_KEY = 'skiri_pwa_installed';
  // Screen height of the tab, measured on the homepage and reused elsewhere
  // so it sits in the same place on every page.
  var TOP_KEY = 'skiri_install_top';

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
    btn.setAttribute('aria-label', 'Install the Mwakete app');
    btn.style.setProperty('--chat-fab-height', CHAT_FAB_HEIGHT + 'px');
    btn.innerHTML = '<span>App Install</span>';
    btn.addEventListener('click', onInstallClick);
    document.body.appendChild(btn);
    placeButton();
    return btn;
  }

  // Level with the middle of the Categories ... Recents row, as it sits at
  // the top of the homepage. Other pages reuse that height (or the CSS
  // default before the homepage has been seen).
  function placeButton() {
    var row = document.querySelector('.quick-action-strip');
    var top = null;
    if (row) {
      var r = row.getBoundingClientRect();
      var h = btn.offsetHeight || 110;
      top = Math.round(r.top + (window.scrollY || 0) + r.height / 2 - h / 2);
      try { localStorage.setItem(TOP_KEY, String(top)); } catch (e) {}
    } else {
      try { top = Number(localStorage.getItem(TOP_KEY)) || null; } catch (e) {}
    }
    // On the root, so the hint beside the tab lines up with it too.
    if (top) document.documentElement.style.setProperty('--install-top', Math.max(40, Math.min(top, window.innerHeight - 160)) + 'px');
  }

  function showButton() {
    if (installed || isStandalone() || !isMobileOrTablet()) return;
    buildButton().classList.add('is-visible');
    placeButton();
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
