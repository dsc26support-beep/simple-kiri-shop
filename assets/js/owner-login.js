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

  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  tabLogin.addEventListener('click', () => switchTab('login'));
  tabRegister.addEventListener('click', () => switchTab('register'));

  function switchTab(which) {
    const isLogin = which === 'login';
    tabLogin.setAttribute('aria-selected', String(isLogin));
    tabRegister.setAttribute('aria-selected', String(!isLogin));
    loginForm.classList.toggle('hidden', !isLogin);
    registerForm.classList.toggle('hidden', isLogin);
  }

  loginForm.addEventListener('submit', onLogin);
  registerForm.addEventListener('submit', onRegister);
  document.getElementById('twofa-form').addEventListener('submit', onVerifyTwoFA);

  wirePasswordToggle('login-password');
  wirePasswordToggle('register-password');

  if (getQueryParam('tab') === 'register') {
    switchTab('register');
  }
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
    return;
  }

  Auth.saveSession(res.token, res.owner);
  // Straight to Settings, not the dashboard - a fresh account has no logo,
  // delivery methods, or location set yet, and settings.html's own
  // required-field validation walks the new owner through finishing that
  // profile (it redirects on to the dashboard once they save successfully).
  window.location.href = 'settings.html';
}
