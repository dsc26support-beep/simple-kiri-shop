document.addEventListener('DOMContentLoaded', init);

function init() {
  if (Auth.getToken()) {
    window.location.href = 'dashboard.html';
    return;
  }

  if (getQueryParam('expired')) {
    document.getElementById('session-message').textContent = 'Your session expired — please log in again.';
  } else if (getQueryParam('deleted')) {
    // Same words as the backend's login error (Auth.gs). A seller can reach this
    // page two ways and should not meet two different messages.
    document.getElementById('session-message').textContent = 'This store has been deleted. Contact now via the Enquiry link below if this is a mistake.';
  }

  document.getElementById('tab-login').addEventListener('click', () => switchTab('login'));
  document.getElementById('tab-register').addEventListener('click', () => switchTab('register'));

  document.getElementById('login-form').addEventListener('submit', onLogin);
  document.getElementById('register-form').addEventListener('submit', onRegister);
  document.getElementById('twofa-form').addEventListener('submit', onVerifyTwoFA);
  document.getElementById('login-go-register').addEventListener('click', goRegisterFromLogin);

  wirePasswordToggle('login-password');
  wirePasswordToggle('register-password');

  // Sent here by guardOwnerAuth with no session at all - see auth.js. Most
  // likely somebody who has not opened a store yet, so Register is the tab
  // they need. The wording does not claim they have no account: a seller on a
  // new phone lands here too, and Log In is the tab beside it.
  if (getQueryParam('needStore')) {
    document.getElementById('session-message').textContent =
      'The seller area needs a store account. Create one below \u2014 or use Log In if you already have a store.';
  }

  if (getQueryParam('tab') === 'register' || getQueryParam('needStore')) {
    switchTab('register');
  }

  showShopperNote();
}

function switchTab(which) {
  const isLogin = which === 'login';
  document.getElementById('tab-login').setAttribute('aria-selected', String(isLogin));
  document.getElementById('tab-register').setAttribute('aria-selected', String(!isLogin));
  // Only hidden, never cleared: somebody sent from one form to the other gets
  // everything they typed back when they switch again.
  document.getElementById('login-form').classList.toggle('hidden', !isLogin);
  document.getElementById('register-form').classList.toggle('hidden', isLogin);
}

/**
 * A shopper account and a store account are two different things, and nothing
 * on this form said so. Someone who tapped Create Store while signed in as a
 * shopper meets a username-and-password form for an account they think they
 * already have.
 *
 * Read from this device only. No request is made, and nothing here is a
 * credential - the shopper's session token is never sent anywhere from this
 * page.
 */
function showShopperNote() {
  const note = document.getElementById('shopper-note');
  if (!note) return;
  if (typeof CustomerAuth === 'undefined' || !CustomerAuth.getToken()) return;

  const customer = CustomerAuth.getCustomer() || {};
  const email = customer.email ? ' (' + customer.email + ')' : '';
  note.textContent = 'You are signed in as a shopper' + email + '. A store account is a '
    + 'separate account with its own username and password. Use the same contact email '
    + 'below and your store will also appear under My Account.';
  note.hidden = false;
}

/**
 * "New here? Register your store", under a failed log-in.
 *
 * The error itself stays vague - the backend compares against a dummy hash so
 * this form cannot be walked to learn which usernames exist - so this offers
 * the route without saying anything about the account. The username comes
 * across so it does not have to be typed twice.
 */
function goRegisterFromLogin() {
  const typed = document.getElementById('login-username').value.trim();
  const target = document.getElementById('register-username');
  if (typed && !target.value) target.value = typed;
  switchTab('register');
  document.getElementById('register-store-name').focus();
}

// The backend's exact words for a username clash (Auth.gs: 'That username is
// already taken'). Matched on the text because this is a frontend-only change
// and adding an error code would mean a redeploy - so verify-seller-signup-route
// asserts that string still exists in Auth.gs, and a reworded backend fails a
// test instead of quietly dropping this route.
const TAKEN_USERNAME_RE = /already taken/i;
const TAKEN_USERNAME_SWITCH_MS = 2200;
let takenUsernameTimer = null;

/**
 * A username that already exists nearly always means this person already has a
 * store and is on the wrong tab. Say so, then move them.
 *
 * After a pause, so the sentence can be read - and cancelled the moment they
 * start editing the username, because somebody who is simply picking a
 * different name must not be yanked off the form mid-thought.
 *
 * Nothing they typed is lost either way: switchTab only hides a form.
 *
 * It reveals nothing new. Registration has to say a username is taken, or it
 * could not refuse it - which is why this side can be plain where the log-in
 * side stays vague.
 */
function offerLoginForTakenUsername() {
  const errorEl = document.getElementById('register-error');
  const usernameEl = document.getElementById('register-username');
  errorEl.textContent += ' If that store is yours, log in instead \u2014 taking you there now.';

  clearTimeout(takenUsernameTimer);
  const cancel = () => { clearTimeout(takenUsernameTimer); takenUsernameTimer = null; };
  usernameEl.addEventListener('input', cancel, { once: true });

  takenUsernameTimer = setTimeout(() => {
    usernameEl.removeEventListener('input', cancel);
    const loginUsername = document.getElementById('login-username');
    if (!loginUsername.value) loginUsername.value = usernameEl.value.trim();
    switchTab('login');
    document.getElementById('login-password').focus();
  }, TAKEN_USERNAME_SWITCH_MS);
}

function setButtonBusy(btn, label, idleLabel) {
  btn.disabled = true;
  btn.dataset.idleLabel = idleLabel;
  btn.innerHTML = `${label}<span class="btn-saving-dots"><span></span><span></span><span></span></span>`;
}

function setButtonIdle(btn) {
  btn.disabled = false;
  btn.textContent = btn.dataset.idleLabel;
}

async function onLogin(e) {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  const submitBtn = document.getElementById('login-submit-btn');
  setButtonBusy(submitBtn, 'Logging in', 'Log In');

  const res = await Api.post('loginOwner', { username, password });

  if (!res.ok) {
    setButtonIdle(submitBtn);
    errorEl.textContent = res.error || 'Could not log in.';
    document.getElementById('login-register-hint').hidden = false;
    return;
  }

  if (res.twoFactorRequired) {
    setButtonIdle(submitBtn);
    document.getElementById('twofa-pending-token').value = res.pendingToken;
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('twofa-form').classList.remove('hidden');
    document.getElementById('twofa-code').focus();
    return;
  }

  Auth.saveSession(res.token, res.owner);
  window.location.href = 'dashboard.html';
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
  window.location.href = 'dashboard.html';
}

async function onRegister(e) {
  e.preventDefault();
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';

  const storeName = document.getElementById('register-store-name').value.trim();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const email = document.getElementById('register-email').value.trim();
  const phone = document.getElementById('register-phone').value.trim();
  const messengerEl = document.getElementById('register-messenger');
  // What the vendor typed becomes the link that will be stored, and the field
  // is rewritten so they SEE it before the request goes out - a value that
  // changed silently on the way to the sheet is one they cannot check.
  const messenger = messengerStoredValue(messengerEl.value);
  if (messenger) messengerEl.value = messenger;

  if (!email) {
    errorEl.textContent = 'Contact email is required — that\'s where customer orders will be sent.';
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
      ? 'That doesn\'t look like a Facebook profile name. Type just the name, e.g. your.name, or paste the link to your profile.'
      : 'Facebook Messenger is required — it\'s how customers message you from your store page.';
    messengerEl.focus();
    return;
  }

  const submitBtn = document.getElementById('register-submit-btn');
  setButtonBusy(submitBtn, 'Creating', 'Create Store Account');

  const res = await Api.post('registerOwner', { storeName, username, password, email, phone, messenger });

  if (!res.ok) {
    setButtonIdle(submitBtn);
    errorEl.textContent = res.error || 'Could not create your store account.';
    if (TAKEN_USERNAME_RE.test(res.error || '')) offerLoginForTakenUsername();
    return;
  }

  Auth.saveSession(res.token, res.owner);
  // Straight to Settings, not the dashboard - a fresh account has no logo,
  // delivery methods, or location set yet, and settings.html's own
  // required-field validation walks the new owner through finishing that
  // profile (it redirects on to the dashboard once they save successfully).
  window.location.href = 'settings.html';
}
