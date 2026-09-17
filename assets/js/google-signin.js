/**
 * Google Sign-In button for the customer login page.
 *
 * Customers only. Vendors sign in with username + password + 2FA and this file
 * is not loaded on any owner page - see apps-script/CustomerOAuth.gs for why.
 *
 * Two pages load this file, and they need different things after a successful
 * sign-in:
 *
 *   customer-login.html - signing in IS the task, so go where they were headed.
 *   checkout.html       - the order is already placed and the screen says
 *                         "CALL SELLER NOW". Navigating away from that would be
 *                         actively harmful, so that page supplies
 *                         window.onCustomerSignedIn and nothing redirects.
 *
 * checkout.html also needs the button rendered LATE: its block starts hidden
 * inside the confirmation section, and Google measures the container when
 * renderButton runs, so rendering into a display:none parent can leave a
 * zero-height button. That page sets window.GOOGLE_SIGNIN_DEFER and calls
 * initGoogleSignIn() itself once the block is on screen.
 *
 * Degrades quietly, in this order:
 *   no GOOGLE_CLIENT_ID configured -> the whole block stays hidden
 *   Google's script blocked/offline -> the block stays hidden
 * Either way the email-code form and the guest button are untouched, so a
 * shopper is never left with no way in. That matters more than the button:
 * this site is used on slow and filtered connections where a third-party
 * script failing to load is an ordinary Tuesday.
 */

var GSI_SRC = 'https://accounts.google.com/gsi/client';

function initGoogleSignIn() {
  var wrap = document.getElementById('google-signin-wrap');
  if (!wrap) return;

  var clientId = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.GOOGLE_CLIENT_ID) || '';
  if (!clientId) return;  // stays hidden - nothing to configure against

  loadGsiScript(function (loaded) {
    if (!loaded || !window.google || !google.accounts || !google.accounts.id) return;
    try {
      google.accounts.id.initialize({
        client_id: clientId,
        callback: onGoogleCredential,
        // The One Tap prompt is deliberately off. It appears unbidden over the
        // page, and on a shared phone it invites signing in as whoever used it
        // last - the exact thing the shared-device checkbox exists to avoid.
        auto_select: false,
        cancel_on_tap_outside: true
      });
      // Shown BEFORE renderButton, not after. Google measures the container it
      // is handed, and a container inside a [hidden] parent measures 0 - which
      // produced a zero-height button on the checkout confirmation screen,
      // where this block is revealed late. Put back on failure.
      wrap.hidden = false;
      google.accounts.id.renderButton(document.getElementById('google-signin-btn'), {
        theme: 'outline',
        size: 'large',
        width: 280,
        text: 'continue_with',
        shape: 'rectangular'
      });
    } catch (e) {
      wrap.hidden = true;   // a half-rendered Google button is worse than none
    }
  });
}

function loadGsiScript(done) {
  if (window.google && window.google.accounts && window.google.accounts.id) return done(true);
  var existing = document.querySelector('script[src="' + GSI_SRC + '"]');
  if (existing) {
    existing.addEventListener('load', function () { done(true); });
    existing.addEventListener('error', function () { done(false); });
    return;
  }
  var s = document.createElement('script');
  s.src = GSI_SRC;
  s.async = true;
  s.defer = true;
  s.onload = function () { done(true); };
  s.onerror = function () { done(false); };
  document.head.appendChild(s);
}

async function onGoogleCredential(response) {
  var errorEl = document.getElementById('google-signin-error');
  var wrap = document.getElementById('google-signin-wrap');
  if (errorEl) errorEl.textContent = '';
  if (!response || !response.credential) {
    if (errorEl) errorEl.textContent = 'Google sign-in did not complete. Please try again.';
    return;
  }

  if (wrap) wrap.classList.add('is-busy');
  var res = await Api.post('googleSignIn', {
    credential: response.credential,
    sharedDevice: typeof sharedDeviceChecked === 'function' ? sharedDeviceChecked() : false
  });
  if (wrap) wrap.classList.remove('is-busy');

  if (!res.ok) {
    if (errorEl) errorEl.textContent = res.error || 'Could not sign you in with Google.';
    return;
  }
  CustomerAuth.saveSession(res.token, res.customer);
  // A page that wants to stay where it is says so. Checkout does: its
  // confirmation screen is the only place the order summary and the seller's
  // number exist.
  if (typeof window.onCustomerSignedIn === 'function') {
    window.onCustomerSignedIn(res.customer);
    return;
  }
  // nextDest() lives in customer-login.js, which is loaded on this page before
  // this file. Reused rather than reimplemented: a second redirect allowlist
  // that disagreed with the first is how one of them ends up being the wrong
  // one, and this is a login page - an open redirect here is a phishing tool.
  window.location.href = typeof nextDest === 'function' ? nextDest() : 'customer-dashboard.html';
}

document.addEventListener('DOMContentLoaded', function () {
  if (window.GOOGLE_SIGNIN_DEFER) return;   // the page will call it when ready
  initGoogleSignIn();
});
