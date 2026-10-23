/**
 * Facebook Login for CUSTOMERS ONLY (owner decision, Oct 2026). Like Google
 * (CustomerOAuth.gs), it never touches the Owners sheet or a seller session.
 *
 * The browser runs Meta's Facebook Login SDK and posts the user access token
 * here. Finishing the SDK's dialog is NOT a Mwakete sign-in: only this file
 * decides, after asking Meta about the token itself.
 *
 * HOW THE TOKEN IS CHECKED (Meta's documented flow)
 *   1. GET /{version}/debug_token?input_token=<token>&access_token=<app id>|<app secret>
 *      - is_valid must be true
 *      - app_id must be OUR app (else a token issued to any other app that
 *        this person uses would sign in here - the same reason Google's `aud`
 *        is checked)
 *      - type must be USER, user_id must be present, expires_at in the future
 *   2. GET /{version}/me?fields=id,name,email&access_token=<token>&appsecret_proof=<HMAC>
 *      - id must equal debug_token's user_id
 *      - appsecret_proof (HMAC-SHA256 of the token with the app secret) proves
 *        the call comes from the holder of the secret.
 * Nothing the browser says about the person (name, email, id) is used.
 *
 * Facebook's email is NOT treated as confirmed: Meta does not give a verified
 * flag for it, so it waits in PendingEmail until Mwakete's own code confirms
 * it (CustomerIdentities.gs, rule 4). A Facebook account that shares no email
 * still gets in, and is asked for one before ordering.
 *
 * Script Properties (the secret never reaches the browser or GitHub):
 *   FACEBOOK_APP_ID        public id (also set in assets/js/config.js)
 *   FACEBOOK_APP_SECRET    PRIVATE
 *   FACEBOOK_GRAPH_VERSION e.g. v23.0 - set it to the version your Meta app
 *                          dashboard shows; the default below is only a fallback
 * Without the id or the secret every request is refused (fails closed).
 * Tokens are never logged; a network error is reported without its message,
 * which could contain the request URL.
 */

var FACEBOOK_GRAPH_VERSION_DEFAULT = 'v23.0';
var FACEBOOK_SIGNIN_MAX = 10;              // per Facebook user per window
var FACEBOOK_SIGNIN_GLOBAL_MAX = 300;      // all Facebook checks per window (protects the fetch quota)
var FACEBOOK_SIGNIN_WINDOW_SECONDS = 900;

function facebookConfig_() {
  var props = PropertiesService.getScriptProperties();
  var version = String(props.getProperty('FACEBOOK_GRAPH_VERSION') || FACEBOOK_GRAPH_VERSION_DEFAULT).trim();
  return {
    appId: String(props.getProperty('FACEBOOK_APP_ID') || '').trim(),
    appSecret: String(props.getProperty('FACEBOOK_APP_SECRET') || '').trim(),
    version: /^v\d+\.\d+$/.test(version) ? version : FACEBOOK_GRAPH_VERSION_DEFAULT
  };
}

function facebookGetJson_(url) {
  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: false });
  } catch (e) {
    return { error: 'network' };
  }
  var json;
  try { json = JSON.parse(response.getContentText()); } catch (e) { return { error: 'parse' }; }
  if (response.getResponseCode() !== 200) return { error: 'status', json: json };
  return { json: json };
}

/** Checks a user access token with Meta. Returns {ok:true, profile} or a fail(). */
function verifyFacebookAccessToken(accessToken) {
  var cfg = facebookConfig_();
  if (!cfg.appId || !cfg.appSecret) return fail('Facebook sign-in is not set up on this site yet');
  if (!accessToken || String(accessToken).length > 4096) return fail('Facebook sign-in failed - please try again');

  var base = 'https://graph.facebook.com/' + cfg.version;
  var debug = facebookGetJson_(base + '/debug_token?input_token=' + encodeURIComponent(accessToken) +
    '&access_token=' + encodeURIComponent(cfg.appId + '|' + cfg.appSecret));
  if (debug.error === 'network') return fail('Could not reach Facebook to check your sign-in. Please try again.');
  var d = debug.json && debug.json.data;
  if (debug.error || !d) return fail('Facebook sign-in failed - please try again');
  if (d.is_valid !== true) return fail('Facebook sign-in failed - please try again');
  if (String(d.app_id) !== cfg.appId) return fail('Facebook sign-in failed - please try again');
  if (d.type && String(d.type).toUpperCase() !== 'USER') return fail('Facebook sign-in failed - please try again');
  if (!d.user_id) return fail('Facebook sign-in failed - please try again');
  if (!(Number(d.expires_at) * 1000 > Date.now())) return fail('That Facebook sign-in expired. Please try again.');

  var proof = bytesToHex(Utilities.computeHmacSha256Signature(String(accessToken), cfg.appSecret));
  var me = facebookGetJson_(base + '/me?fields=id,name,email&access_token=' + encodeURIComponent(accessToken) +
    '&appsecret_proof=' + proof);
  if (me.error === 'network') return fail('Could not reach Facebook to check your sign-in. Please try again.');
  if (me.error || !me.json || String(me.json.id) !== String(d.user_id)) return fail('Facebook sign-in failed - please try again');

  return { ok: true, profile: {
    provider: 'facebook',
    providerUserId: String(d.user_id),
    email: normalizeEmail(me.json.email || ''),
    emailVerified: false,   // see the file comment
    name: String(me.json.name || '')
  } };
}

/**
 * Sign in (or sign up, or link from the account page) with Facebook.
 * body: { accessToken, customerToken? }
 */
function actionFacebookSignIn(body) {
  body = body || {};
  if (rateLimitHit('ratelimit:facebooksignin:all', FACEBOOK_SIGNIN_GLOBAL_MAX, FACEBOOK_SIGNIN_WINDOW_SECONDS)) {
    return fail('Facebook sign-in is busy right now. Please try again in a few minutes, or use email.');
  }
  var verified = verifyFacebookAccessToken(body.accessToken);
  if (!verified.ok) return verified;
  if (rateLimitHit('ratelimit:facebooksignin:' + verified.profile.providerUserId, FACEBOOK_SIGNIN_MAX, FACEBOOK_SIGNIN_WINDOW_SECONDS)) {
    return fail('Too many sign-in attempts. Please wait a few minutes and try again.');
  }
  return resolveProviderSignIn(verified.profile, body);
}

