/**
 * "Continue with Facebook" - shoppers only, like Google (google-signin.js).
 *
 * Off until set up: with no APP_CONFIG.FACEBOOK_APP_ID the button never
 * appears, and the server refuses Facebook sign-ins anyway until
 * FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are in Script Properties
 * (FacebookAuth.gs). The App ID is public by design; the App Secret is never
 * in this site's code.
 *
 * Meta's SDK is loaded only when the button is tapped, so pages stay light
 * and nothing is sent to Meta by merely opening the sign-in page. Finishing
 * Facebook's dialog does not sign anyone in: the access token goes to the
 * server, which asks Meta whether it is valid and issued to OUR app.
 */

var FB_SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
var FB_GRAPH_VERSION = 'v23.0';   // keep in step with FACEBOOK_GRAPH_VERSION in Script Properties

function facebookAppId() {
  return (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.FACEBOOK_APP_ID) || '';
}

function initFacebookSignIn() {
  var wrap = document.getElementById('facebook-signin-wrap');
  var btn = document.getElementById('facebook-signin-btn');
  if (!wrap || !btn || !facebookAppId()) return;   // stays hidden
  wrap.hidden = false;
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', onFacebookClick);
}

function loadFacebookSdk(done) {
  if (window.FB) return done(true);
  var timer = setTimeout(function () { done(false); }, 15000);
  window.fbAsyncInit = function () {
    clearTimeout(timer);
    try {
      FB.init({ appId: facebookAppId(), cookie: false, xfbml: false, version: FB_GRAPH_VERSION });
      done(true);
    } catch (e) { done(false); }
  };
  var s = document.createElement('script');
  s.src = FB_SDK_SRC;
  s.async = true;
  s.defer = true;
  s.crossOrigin = 'anonymous';
  s.onerror = function () { clearTimeout(timer); done(false); };
  document.head.appendChild(s);
}

function onFacebookClick() {
  var btn = document.getElementById('facebook-signin-btn');
  var errorEl = document.getElementById('facebook-signin-error');
  if (errorEl) errorEl.textContent = '';
  var busyDone = typeof setButtonBusy === 'function' ? setButtonBusy(btn, 'Opening Facebook') : function () {};
  loadFacebookSdk(function (loaded) {
    if (!loaded || !window.FB) {
      busyDone();
      if (errorEl) errorEl.textContent = 'Facebook could not be reached. Please try again, or use your email.';
      return;
    }
    FB.login(async function (response) {
      var auth = response && response.authResponse;
      if (!auth || !auth.accessToken) {
        busyDone();
        if (errorEl) errorEl.textContent = 'Facebook sign-in did not complete. Please try again.';
        return;
      }
      var res = await Api.post('facebookSignIn', providerSignInBody({ accessToken: auth.accessToken }));
      busyDone();
      handleProviderResult(res, errorEl, 'Facebook');
    }, { scope: 'public_profile,email' });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  if (window.FACEBOOK_SIGNIN_DEFER) return;   // the page will call it when ready (account page)
  initFacebookSignIn();
});
