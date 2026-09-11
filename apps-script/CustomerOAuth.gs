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
 * REQUIRES two additional columns on the Customers sheet. Both are optional at
 * read time, so an un-migrated sheet keeps working and email sign-in is
 * unaffected:
 *   AuthProvider   'email' | 'google'  - how the account was last verified
 *   GoogleSub      Google's stable user id, for the account-linking note below
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

  return { ok: true, claims: claims };
}

/**
 * Sign in (or sign up) a customer with a Google ID token.
 *
 * body: { credential, sharedDevice }
 *
 * ACCOUNT LINKING. If a Customers row already exists for the verified address,
 * this signs into it rather than creating a duplicate - so someone who signed
 * up with an email code and later taps "Continue with Google" keeps their order
 * history. That is safe only because email_verified was checked above: Google
 * has proven the person controls that mailbox, which is the same thing the
 * email-code flow proves.
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

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var customer = findCustomerByEmail(email);
    if (!customer) {
      var sheet = getSheet('Customers');
      var customerId = 'cust_' + Utilities.getUuid();
      var row = {
        CustomerId: customerId,
        Name: String(claims.name || '').trim() || email.split('@')[0],
        Email: email,
        Phone: '',
        EmailVerified: 'true',
        CreatedAt: nowIso(),
        UpdatedAt: nowIso()
      };
      // ensureColumn adds a header if it is missing and does nothing if it is
      // not. It appends a column and moves no existing one, so the cells
      // beneath it are empty by construction - the "not set" state every
      // reader already treats as the default. Purely additive, per the
      // never-drop-a-column rule.
      ensureColumn(sheet, 'AuthProvider');
      ensureColumn(sheet, 'GoogleSub');
      row.AuthProvider = 'google';
      row.GoogleSub = String(claims.sub || '');
      appendRowFromObject(sheet, row);
      customer = findRowById(sheet, 'CustomerId', customerId);
    } else {
      markCustomerGoogleLinked(customer, claims);
    }
  } finally {
    lock.releaseLock();
  }

  if (!customer) return fail('Could not create your account. Please try again.');

  var token = issueCustomerSession(customer.CustomerId, { sharedDevice: body.sharedDevice === true });
  return ok({ token: token, customer: publicCustomerFields(customer) });
}

/**
 * Records that this account has now been verified through Google. Best-effort:
 * a write failure must never block a sign-in that has already been proven
 * valid, so this swallows its own errors rather than failing the request.
 */
function markCustomerGoogleLinked(customer, claims) {
  try {
    var sheet = getSheet('Customers');
    ensureColumn(sheet, 'AuthProvider');
    ensureColumn(sheet, 'GoogleSub');
    var patch = {
      UpdatedAt: nowIso(),
      AuthProvider: 'google',
      GoogleSub: String(claims.sub || '')
    };
    // Google proved control of the mailbox, which is the same thing the email
    // code proves - so an account that was never confirmed becomes confirmed.
    if (String(customer.EmailVerified) !== 'true') patch.EmailVerified = 'true';
    updateRowFromObject(sheet, customer.__row, patch);
  } catch (e) {
    // Non-fatal by design - see the doc comment.
  }
}
