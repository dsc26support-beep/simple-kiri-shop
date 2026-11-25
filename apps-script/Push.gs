/**
 * Web Push via Firebase Cloud Messaging (CESN Stage 3).
 *
 * DORMANT UNLESS CONFIGURED. Push is an OPTIONAL extra channel on top of the
 * in-app Notification Centre (Engagement.gs), which works regardless. Nothing
 * here sends anything until the owner puts a Google service-account JSON in the
 * Script Property FCM_SERVICE_ACCOUNT (see docs/cesn-architecture.md 5.1). With
 * it unset, registration still records tokens harmlessly and every send is a
 * no-op, so deploying this file changes nothing on its own.
 *
 * Pure Apps Script cannot do Web Push payload encryption, so we hand the
 * message to FCM HTTP v1 (it encrypts). Auth is a short-lived OAuth token
 * minted from the service account with an RS256-signed JWT - no key is ever
 * sent to the browser.
 *
 * A send never runs inside a script lock (it does network I/O): the engine
 * calls sendPushToCustomer from its batched sweep, not from a follow/like
 * mutation.
 */

function pushServiceAccount_() {
  var raw = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    var sa = JSON.parse(raw);
    return (sa && sa.client_email && sa.private_key && sa.project_id) ? sa : null;
  } catch (e) { return null; }
}

function pushEnabled() { return !!pushServiceAccount_(); }

/* ---------------------------------------------------------------------------
 * Device subscriptions (the browser's FCM registration token)
 * ------------------------------------------------------------------------- */

function actionRegisterPushSubscription(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var tokenStr = String((body && body.fcmToken) || '').trim();
  if (!tokenStr) return fail('fcmToken is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('PushSubscriptions');
    var now = nowIso();
    var existing = sheetToObjects(sheet).filter(function (r) { return String(r.FcmToken) === tokenStr; })[0];
    if (existing) {
      updateRowFromObject(sheet, existing.__row, {
        CustomerId: customer.CustomerId, Status: 'active',
        UserAgent: String(body.userAgent || '').slice(0, 200), Platform: String(body.platform || '').slice(0, 40), LastSeenAt: now
      });
    } else {
      appendRowFromObject(sheet, {
        SubId: newId('psub'), CustomerId: customer.CustomerId, FcmToken: tokenStr,
        UserAgent: String(body.userAgent || '').slice(0, 200), Platform: String(body.platform || '').slice(0, 40),
        Status: 'active', LastSeenAt: now, CreatedAt: now
      });
    }
  } finally { lock.releaseLock(); }
  return ok({ registered: true, pushEnabled: pushEnabled() });
}

function actionUnregisterPushSubscription(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var tokenStr = String((body && body.fcmToken) || '').trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('PushSubscriptions');
    sheetToObjects(sheet).forEach(function (r) {
      if (String(r.FcmToken) === tokenStr && String(r.CustomerId) === String(customer.CustomerId) && String(r.Status) === 'active') {
        updateRowFromObject(sheet, r.__row, { Status: 'disabled', LastSeenAt: nowIso() });
      }
    });
  } finally { lock.releaseLock(); }
  return ok({ unregistered: true });
}

/* ---------------------------------------------------------------------------
 * Sending (FCM HTTP v1)
 * ------------------------------------------------------------------------- */

// Mint a Google OAuth access token for the FCM scope from the service account.
function pushAccessToken_(sa) {
  var now = Math.floor(Date.now() / 1000);
  var enc = function (o) { return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, ''); };
  var unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, '');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }
  });
  var data = {};
  try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) { data = {}; }
  return data.access_token || null;
}

function pushLink_(note) {
  var base = PropertiesService.getScriptProperties().getProperty('SITE_BASE_URL') || '';
  var path = (note && note.deepLink) || 'customer-dashboard.html';
  return base ? (base.replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '')) : String(path);
}

function pushSendOne_(projectId, accessToken, sub, note) {
  var payload = { message: {
    token: sub.FcmToken,
    notification: { title: note.title || 'Mwakete', body: note.body || '' },
    webpush: { fcmOptions: { link: pushLink_(note) }, notification: note.imageUrl ? { image: note.imageUrl } : {} }
  } };
  var res = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true, payload: JSON.stringify(payload)
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true };
  var text = '';
  try { text = res.getContentText() || ''; } catch (e) { text = ''; }
  // A dead/removed token: stop using it. FCM reports 404 UNREGISTERED or
  // 400 with these error strings.
  if (code === 404 || /UNREGISTERED|NOT_FOUND|InvalidRegistration/i.test(text)) return { ok: false, unregistered: true };
  return { ok: false, error: 'FCM ' + code };
}

/**
 * Deliver one notification to every active device of a customer. Prunes tokens
 * FCM reports as gone. Returns {sent, pruned, skipped?}. Safe to call when push
 * is not configured (returns immediately). NEVER call inside a script lock.
 */
function sendPushToCustomer(customerId, note) {
  var sa = pushServiceAccount_();
  if (!sa) return { sent: 0, pruned: 0, skipped: 'disabled' };
  var sheet = getSheet('PushSubscriptions');
  var subs = sheetToObjects(sheet).filter(function (r) { return String(r.CustomerId) === String(customerId) && String(r.Status) === 'active'; });
  if (!subs.length) return { sent: 0, pruned: 0 };
  var at = pushAccessToken_(sa);
  if (!at) return { sent: 0, pruned: 0, skipped: 'no-token' };
  var sent = 0, pruned = 0;
  subs.forEach(function (sub) {
    var r = pushSendOne_(sa.project_id, at, sub, note || {});
    if (r.ok) sent++;
    else if (r.unregistered) { updateRowFromObject(sheet, sub.__row, { Status: 'unregistered', LastSeenAt: nowIso() }); pruned++; }
  });
  return { sent: sent, pruned: pruned };
}

// Best-effort push alongside an in-app notification. The later engine calls
// this from its batched sweep (outside any lock); a failure never blocks the
// in-app row. Guarded so Engagement.gs stays independent of this file.
function maybePushNotification_(customerId, note) {
  try { if (pushEnabled()) sendPushToCustomer(customerId, note); } catch (e) { /* best effort */ }
}
