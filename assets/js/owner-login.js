document.addEventListener('DOMContentLoaded', init);

function init() {
  if (Auth.getToken()) {
    window.location.href = 'dashboard.html';
    return;
  }

  if (getQueryParam('expired')) {
    document.getElementById('session-message').textContent = 'Your session expired — please log in again.';
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

async function onLogin(e) {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  const res = await Api.post('loginOwner', { username, password });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not log in.';
    return;
  }

  if (res.twoFactorRequired) {
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

  if (!email) {
    errorEl.textContent = 'Contact email is required — that\'s where customer orders will be sent.';
    return;
  }
  if (!phone) {
    errorEl.textContent = 'Contact phone is required — it\'s shown to customers as a backup way to reach you.';
    return;
  }

  const res = await Api.post('registerOwner', { storeName, username, password, email, phone });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not create your store account.';
    return;
  }

  Auth.saveSession(res.token, res.owner);
  window.location.href = 'dashboard.html';
}
