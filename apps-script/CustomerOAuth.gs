/**
 * Google Sign-In for CUSTOMERS ONLY.
 *
 * Vendors are deliberately not covered. A vendor signs in with username +
 * password + optional email 2FA + lockout (Auth.gs). Letting a vendor sign in
 * with Google would turn a Google account takeover into a full store takeover
 * with no second factor, and would quietly undo the 2FA work already shipped.
 * Nothing in this file touches Auth.gs or the Owners sheet.
 *
 * HOW THE TOKEN IS CHECKED
 * ------------------------
 * The browser gets an ID token (a JWT) from Google Identity Services and posts
 * it here. Apps Script has no RSA/JWT verification built in, so rather than
 * hand-roll signature checking we hand the token back to Google's own
 * tokeninfo endpoint, which validates the signature and returns the claims.
 * One extra network call per sign-in, which is nothing - people sign in rarely.
 *
 * Every one of these checks is load-bearing. Dropping any of them makes the
 * endpoint forgeable:
 *
 *   aud   === our client id   Without this, an ID token minted for ANY other
 *                             Google app would be accepted here. This is the
 *                             single most important check on the whole path.
 *   iss   is accounts.google.com
 *   exp   is in the future
 *   email_verified === true   Google returns unverified addresses for some
 *                             account types. An unverified address must never
 *                             match an existing Mwakete account, or signing in
 *                             with an unverified "someone@example.com" would
 *                             hand over that person's order history.
 *
 * The client id lives in Script Properties as GOOGLE_CLIENT_ID. If it is not
 * set, this endpoint refuses every request - it fails CLOSED, never open.
 *
 * Links are stored in the ProviderIdentities sheet (CustomerIdentities.gs).
 * Customers.GoogleSub, written by the first version of this file, is still
 * read as an existing link and moved across on first use.
 */

// Sign-in attempts allowed per address per window (anti brute-force on a
// stolen-token replay; mirrors the customer email-code limiter).
var GOOGLE_SIGNIN_MAX = 10;
var GOOGLE_SIGNIN_WINDOW_SECONDS = 900;

var GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
var GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Verifies a Google ID token and returns {ok:true, claims:{...}} or a fail().
 * Split out from actionGoogleSignIn so it can be tested without a session.
 */
function verifyGoogleIdToken(idToken) {
  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) {
    // Fail closed. Without a client id there is nothing to check `aud` against,
    // and an unchecked `aud` means any Google token from any app is accepted.
    return fail('Google sign-in is not configured on this site yet');
  }
  if (!idToken) return fail('Google sign-in failed - no token received');

  var response;
  try {
    response = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL + encodeURIComponent(idToken), {
      muteHttpExceptions: true
    });
  } catch (e) {
    return fail('Could not reach Google to check your sign-in. Please try again.');
  }
  if (response.getResponseCode() !== 200) {
    return fail('Google sign-in failed - please try again');
  }

  var claims;
  try {
    claims = JSON.parse(response.getContentText());
  } catch (e) {
    return fail('Google sign-in failed - please try again');
  }

  if (String(claims.aud) !== String(clientId)) return fail('Google sign-in failed - please try again');
  if (GOOGLE_ISSUERS.indexOf(String(claims.iss)) === -1) return fail('Google sign-in failed - please try again');
  if (!(Number(claims.exp) * 1000 > Date.now())) return fail('That Google sign-in expired. Please try again.');
  // tokeninfo returns these as strings.
  if (String(claims.email_verified) !== 'true') {
    return fail('That Google account has no verified email address, so it cannot be used to sign in here.');
  }
  if (!claims.email) return fail('That Google account did not share an email address');
  // `sub` is the stable Google id that a link is keyed on (never the email).
  if (!claims.sub) return fail('Google sign-in failed - please try again');

  return { ok: true, claims: claims };
}

/**
 * Sign in (or sign up, or link from the account page) with a Google ID token.
 *
 * body: { credential, customerToken? }
 *
 * After the token is verified, the account rules live in
 * CustomerIdentities.gs (resolveProviderSignIn): an identity seen before signs
 * in to its own account; a new one whose email matches an existing account is
 * NOT merged automatically - the shopper proves that account first and the
 * link is made then. Accounts that used Google before this change carry their
 * Google id in Customers.GoogleSub and keep signing straight in.
 */
function actionGoogleSignIn(body) {
  body = body || {};
  var verified = verifyGoogleIdToken(body.credential);
  if (!verified.ok) return verified;

  var claims = verified.claims;
  var email = normalizeEmail(claims.email);

  if (rateLimitHit('ratelimit:googlesignin:' + email, GOOGLE_SIGNIN_MAX, GOOGLE_SIGNIN_WINDOW_SECONDS)) {
    return fail('Too many sign-in attempts. Please wait a few minutes and try again.');
  }

  return resolveProviderSignIn({
    provider: 'google',
    providerUserId: String(claims.sub),
    email: email,
    // verifyGoogleIdToken has already refused any token whose email_verified is not true.
    emailVerified: true,
    name: String(claims.name || '')
  }, body);
}
