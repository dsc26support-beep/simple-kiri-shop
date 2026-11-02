document.addEventListener('DOMContentLoaded', init);

// Where to go after logging in: ?next= (e.g. Messages, from a new-message
// email - auth.js adds it), else the dashboard. Only a page in this folder.
function ownerNextPage() {
  const next = getQueryParam('next') || '';
  return /^(?!login\.html)[a-z-]+\.html(\?[a-zA-Z0-9=&%._-]*)?$/.test(next) ? next : 'dashboard.html';
}

function init() {
  if (Auth.getToken()) {
    window.location.href = ownerNextPage();
    return;
  }
  attachStoreNameCounter(document.getElementById('register-store-name'));

  if (getQueryParam('expired')) {
    document.getElementById('session-message').textContent = 'Your session expired — please sign in again.';
  } else if (getQueryParam('deleted')) {
    // Same words as the backend (Auth.gs). A seller can reach this page two
    // ways and should not meet two different messages.
    document.getElementById('session-message').textContent = 'This store has been deleted. Contact now via the Help and support link below if this is a mistake.';
  }

  document.getElementById('tab-login').addEventListener('click', () => switchTab('login'));
  document.getElementById('tab-register').addEventListener('click', () => switchTab('register'));
  document.getElementById('register-form').addEventListener('submit', onRegister);
  document.querySelectorAll('input[name="storeType"]').forEach((r) => r.addEventListener('change', onStoreTypeChange));
  document.getElementById('twofa-form').addEventListener('submit', onVerifyTwoFA);
  document.getElementById('login-continue').addEventListener('click', () => openStoreFromAccount());
  // Back here after signing in, then on to the page that sent them.
  document.getElementById('login-signin-link').href = '../customer-login.html?next=' +
    encodeURIComponent('owner/login.html' + (getQueryParam('next') ? '?next=' + encodeURIComponent(getQueryParam('next')) : ''));

  if (getQueryParam('tab') === 'register') switchTab('register');

  showShopperNote();
  prepareRegisterForm();

  const signedIn = typeof CustomerAuth !== 'undefined' && !!CustomerAuth.getToken();
  if (!signedIn) {
    document.getElementById('login-signin').hidden = false;
  } else if (Auth.sellerSignedOut()) {
    // They pressed Log out: wait for a tap rather than reopening the store.
    document.getElementById('login-continue').hidden = false;
  } else {
    openStoreFromAccount();
  }
}

/**
 * One sign-in (owner decision, 2 Nov 2026): the Mwakete account signed in on
 * this device opens its store - no store username or password. No store yet:
 * the Register tab. The server decides which store (Auth.gs
 * actionOwnerFromCustomer); nothing here is trusted.
 */
async function openStoreFromAccount() {
  const status = document.getElementById('login-status');
  const errorEl = document.getElementById('login-error');
  const cont = document.getElementById('login-continue');
  errorEl.textContent = '';
  cont.hidden = true;
  status.innerHTML = loadingMessageHtml('Opening your store');
  const res = await Auth.fromCustomerAccount(CustomerAuth.getToken());
  status.textContent = '';
  if (res.ok && res.token) {
    window.location.href = ownerNextPage();
    return;
  }
  if (res.ok && res.twoFactorRequired) {
    document.getElementById('twofa-pending-token').value = res.pendingToken;
    document.getElementById('login-panel').classList.add('hidden');
    document.getElementById('twofa-form').classList.remove('hidden');
    document.getElementById('twofa-code').focus();
    return;
  }
  if (res.ok && res.noStore) {
    document.getElementById('session-message').textContent =
      'This account has no store yet. Open one below - it takes a few minutes.';
    switchTab('register');
    return;
  }
  if (res.errorKind === 'customer_auth') {
    // The account session is gone or unconfirmed: sign in again.
    document.getElementById('login-signin').hidden = false;
  } else if (!res.storeBlocked) {
    cont.hidden = false;   // a network hiccup: let them try again
  }
  errorEl.textContent = res.error || 'Could not open your store. Please try again.';
}

/**
 * Become a Seller: the Register tab is an application from the shopper
 * account signed in on this device. Without one, the fields are replaced by a
 * way to sign in first; the store email is that account's email. The server
 * enforces both (Auth.gs actionRegisterOwner) - this only saves a wasted form.
 */
function prepareRegisterForm() {
  const customer = typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken() ? CustomerAuth.getCustomer() : null;
  const signedIn = !!(customer && customer.email);
  document.getElementById('register-account-gate').hidden = signedIn;
  document.getElementById('register-fields').hidden = !signedIn;
  if (signedIn) document.getElementById('register-email').value = customer.email;
}

function showApplicationSent(application) {
  const box = document.getElementById('register-sent');
  box.textContent = '';
  const p1 = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = 'Application sent.';
  p1.appendChild(strong);
  p1.appendChild(document.createTextNode(' Thank you - we will review "' + application.storeName +
    '" and email you the answer. You can check its status any time on My Account.'));
  const link = document.createElement('a');
  link.className = 'btn btn-outline btn-block';
  link.href = '../customer-dashboard.html#seller-app';
  link.textContent = 'Go to My Account';
  box.appendChild(p1);
  box.appendChild(link);
  box.hidden = false;
  document.getElementById('register-fields').hidden = true;
}

function switchTab(which) {
  const isLogin = which === 'login';
  document.getElementById('tab-login').setAttribute('aria-selected', String(isLogin));
  document.getElementById('tab-register').setAttribute('aria-selected', String(!isLogin));
  // Only hidden, never cleared: what they typed comes back when they switch again.
  document.getElementById('login-panel').classList.toggle('hidden', !isLogin);
  document.getElementById('twofa-form').classList.add('hidden');
  document.getElementById('register-form').classList.toggle('hidden', isLogin);
}

/**
 * Who is signed in, and a Google button to switch account (owner request,
 * Oct 2026). Only for a signed-in account - nobody else loads Google's script
 * from here; the sign-in link covers them.
 */
function showShopperNote() {
  if (typeof CustomerAuth === 'undefined' || !CustomerAuth.getToken()) return;
  setShopperNote(CustomerAuth.getCustomer());
  window.onCustomerSignedIn = (c) => { setShopperNote(c); prepareRegisterForm(); Auth.setSellerSignedOut(false); openStoreFromAccount(); };
  if (typeof initGoogleSignIn === 'function') initGoogleSignIn();
}

// Owner request (Oct 2026): "You are signed in (email)" - just who, highlighted.
function setShopperNote(customer) {
  const note = document.getElementById('shopper-note');
  const email = customer && customer.email ? ' (' + customer.email + ')' : '';
  note.textContent = 'You are signed in' + email;
  note.hidden = false;
}

// google-signin.js renders on DOMContentLoaded unless told to wait. Here it
// waits for showShopperNote, which knows whether anybody is signed in.
window.GOOGLE_SIGNIN_DEFER = true;

// The shared busy button (helpers.js setButtonBusy); done() puts the label back.
function setLoginButtonBusy(btn, label) {
  btn.busyDone = setButtonBusy(btn, label);
}

function setButtonIdle(btn) {
  if (btn.busyDone) btn.busyDone();
  btn.busyDone = null;
}

async function onVerifyTwoFA(e) {
  e.preventDefault();
  const errorEl = document.getElementById('twofa-error');
  errorEl.textContent = '';

  const pendingToken = document.getElementById('twofa-pending-token').value;
  const code = document.getElementById('twofa-code').value.trim();

  const res = await Api.post('verifyLoginCode', { pendingToken, code });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not verify that code.';
    return;
  }

  Auth.saveSession(res.token, res.owner);
  Auth.setSellerSignedOut(false);
  window.location.href = ownerNextPage();
}

async function onRegister(e) {
  e.preventDefault();
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';

  const storeName = document.getElementById('register-store-name').value.trim();
  const phone = document.getElementById('register-phone').value.trim();
  const about = document.getElementById('register-about').value.trim();
  const storeTypeEl = document.querySelector('input[name="storeType"]:checked');
  const storeType = storeTypeEl ? storeTypeEl.value : 'retailer';
  const messengerEl = document.getElementById('register-messenger');
  // What the vendor typed becomes the link that will be stored, and the field
  // is rewritten so they SEE it before the request goes out - a value that
  // changed silently on the way to the sheet is one they cannot check.
  const messenger = messengerStoredValue(messengerEl.value);
  if (messenger) messengerEl.value = messenger;

  if (Array.from(storeName).length > STORE_NAME_MAX) {
    errorEl.textContent = `Store name must be ${STORE_NAME_MAX} characters or fewer.`;
    return;
  }
  if (!phone) {
    errorEl.textContent = 'Contact phone is required — it\'s shown to customers as a backup way to reach you.';
    return;
  }
  // Two different failures, two different messages: nothing typed at all, or
  // something typed that carries no profile name (a bare "facebook.com", a
  // link to someone else's site). Telling both "this is required" would leave
  // the second vendor staring at a filled-in box.
  if (!messenger) {
    errorEl.textContent = messengerEl.value.trim()
      ? 'That doesn\'t look like a Facebook username. Type just the username, e.g. your.name, or paste the link to your profile.'
      : 'Facebook Messenger is required — it\'s how customers message you from your store page.';
    messengerEl.focus();
    return;
  }

  const submitBtn = document.getElementById('register-submit-btn');
  setLoginButtonBusy(submitBtn, 'Creating');

  if (!about) {
    errorEl.textContent = 'Tell us in a sentence what you will sell.';
    document.getElementById('register-about').focus();
    return;
  }

  const res = await Api.post('registerOwner', { storeName, phone, messenger, storeType, about,
    customerToken: typeof CustomerAuth !== 'undefined' ? CustomerAuth.getToken() : '' });

  if (!res.ok) {
    setButtonIdle(submitBtn);
    errorEl.textContent = res.error || 'Could not send your application.';
    if (res.customerAccountRequired) {
      document.getElementById('register-account-gate').hidden = false;
      document.getElementById('register-fields').hidden = true;
    }
    return;
  }

  setButtonIdle(submitBtn);
  // Every new store waits for an admin. Only the first admin (ADMIN_EMAILS)
  // is approved at once and gets a session.
  if (!res.token) {
    showApplicationSent(res.application || { storeName });
    return;
  }
  Auth.saveSession(res.token, res.owner);
  Auth.setSellerSignedOut(false);
  // Straight to Settings, not the dashboard - a fresh account has no logo,
  // delivery methods, or location set yet, and settings.html's own
  // required-field validation walks the new owner through finishing that
  // profile (it redirects on to the dashboard once they save successfully).
  window.location.href = 'settings.html';
}

// Told the moment they pick it, before they've filled in anything else - a
// wholesaler should know a call is coming before committing to the choice.
function onStoreTypeChange() {
  const picked = document.querySelector('input[name="storeType"]:checked');
  document.getElementById('wholesaler-note').hidden = !(picked && picked.value === 'wholesaler');
}
