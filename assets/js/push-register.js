/**
 * Web Push opt-in (CESN Stage 3). STRICTLY DORMANT unless APP_CONFIG.PUSH_CONFIG
 * is set (the owner's Firebase web config + VAPID public key). With it null -
 * the default - nothing here loads any Firebase code, requests any permission,
 * or makes any request; MwaketePush.supported() is false and the dashboard's
 * "Turn on notifications" button stays hidden. The in-app Notification Centre
 * is independent of all this.
 *
 * Only an explicit customer gesture (the button) ever triggers the OS
 * permission prompt - following or liking never does.
 */
(function () {
  var cfg = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.PUSH_CONFIG) || null;

  function supported() {
    return !!cfg && !!cfg.vapidKey &&
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
      typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
  }

  // 'unsupported' | 'default' | 'granted' | 'denied'
  function status() {
    if (!supported()) return 'unsupported';
    try { return Notification.permission; } catch (e) { return 'unsupported'; }
  }

  async function enable() {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    var perm;
    try { perm = await Notification.requestPermission(); } catch (e) { return { ok: false, reason: 'error' }; }
    if (perm !== 'granted') return { ok: false, reason: perm };
    try {
      // Loaded only now, only from the allow-listed Google host, only after the
      // owner configured push and the customer asked for it.
      var appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      var msgMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
      var app = appMod.initializeApp({
        apiKey: cfg.apiKey, projectId: cfg.projectId, appId: cfg.appId, messagingSenderId: cfg.messagingSenderId
      });
      var messaging = msgMod.getMessaging(app);
      // The background SW needs the (public) config too; pass it in the query so
      // the owner never has to edit a second file.
      var qs = 'apiKey=' + encodeURIComponent(cfg.apiKey) + '&projectId=' + encodeURIComponent(cfg.projectId) +
        '&messagingSenderId=' + encodeURIComponent(cfg.messagingSenderId) + '&appId=' + encodeURIComponent(cfg.appId);
      var swReg = await navigator.serviceWorker.register('firebase-messaging-sw.js?' + qs);
      var fcmToken = await msgMod.getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: swReg });
      if (!fcmToken) return { ok: false, reason: 'no-token' };
      var token = (typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken) ? CustomerAuth.getToken() : null;
      if (!token) return { ok: false, reason: 'signed-out' };
      var res = await Api.post('registerPushSubscription', {
        token: token, fcmToken: fcmToken,
        userAgent: (navigator.userAgent || '').slice(0, 200),
        platform: (navigator.platform || 'web').slice(0, 40)
      });
      // Show incoming messages while the page is open, too.
      try { msgMod.onMessage(messaging, function () {}); } catch (e) { /* optional */ }
      return { ok: !!(res && res.ok) };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  }

  window.MwaketePush = { supported: supported, status: status, enable: enable };
})();
