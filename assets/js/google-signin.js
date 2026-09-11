/**
 * Google Sign-In button for the customer login page.
 *
 * Customers only. Vendors sign in with username + password + 2FA and this file
 * is not loaded on any owner page - see apps-script/CustomerOAuth.gs for why.
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
      google.accounts.id.renderButton(document.getElementById('google-signin-btn'), {
        theme: 'outline',
        size: 'large',
        width: 280,
        text: 'continue_with',
        shape: 'rectangular'
      });
      wrap.hidden = false;
    } catch (e) {
      // Leave it hidden. A half-rendered Google button is worse than none.
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
  // nextDest() lives in customer-login.js, which is loaded on this page before
  // this file. Reused rather than reimplemented: a second redirect allowlist
  // that disagreed with the first is how one of them ends up being the wrong
  // one, and this is a login page - an open redirect here is a phishing tool.
  window.location.href = typeof nextDest === 'function' ? nextDest() : 'customer-dashboard.html';
}

document.addEventListener('DOMContentLoaded', initGoogleSignIn);
