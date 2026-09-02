document.addEventListener('DOMContentLoaded', init);

let signupPendingToken = null;
let loginPendingToken = null;

function init() {
  // Already signed in? Skip straight to where they were headed.
  if (CustomerAuth.isLoggedIn()) {
    window.location.href = nextDest();
    return;
  }

  document.getElementById('tab-signin').addEventListener('click', () => showTab('signin'));
  document.getElementById('tab-signup').addEventListener('click', () => showTab('signup'));

  document.getElementById('login-form').addEventListener('submit', onLoginRequest);
  document.getElementById('login-code-form').addEventListener('submit', onLoginVerify);
  document.getElementById('login-back').addEventListener('click', resetLogin);

  document.getElementById('signup-form').addEventListener('submit', onSignupRequest);
  document.getElementById('signup-code-form').addEventListener('submit', onSignupVerify);
  document.getElementById('signup-back').addEventListener('click', resetSignup);

  if (getQueryParam('tab') === 'signup') showTab('signup');
}

// Where to go after a successful sign in. Supports ?next= for returning to a
// page (e.g. checkout), but only same-site relative paths - never an absolute
// or off-site URL (open-redirect guard).
function nextDest() {
  const next = getQueryParam('next');
  if (next && !/^https?:/i.test(next) && !next.startsWith('//') && /^[a-zA-Z0-9_\-./?=&%]+$/.test(next)) {
    return next;
  }
  return 'customer-dashboard.html';
}

function showTab(which) {
  const signin = which === 'signin';
  document.getElementById('tab-signin').classList.toggle('is-active', signin);
  document.getElementById('tab-signin').setAttribute('aria-selected', signin ? 'true' : 'false');
  document.getElementById('tab-signup').classList.toggle('is-active', !signin);
  document.getElementById('tab-signup').setAttribute('aria-selected', !signin ? 'true' : 'false');
  document.getElementById('panel-signin').classList.toggle('hidden', !signin);
  document.getElementById('panel-signup').classList.toggle('hidden', signin);
  document.getElementById('auth-title').textContent = signin ? 'Sign in to Mwakete' : 'Create your Mwakete account';
}

/* ---------- Sign in ---------- */

async function onLoginRequest(e) {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    errorEl.textContent = 'Please enter your email.';
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const res = await Api.post('loginCustomer', { email });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not send a code. Please try again.';
    return;
  }
  loginPendingToken = res.pendingToken;
  document.getElementById('login-code-hint').textContent = `We emailed a 6-digit code to ${email}. Enter it below.`;
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('login-code-form').classList.remove('hidden');
  document.getElementById('login-code').focus();
}

async function onLoginVerify(e) {
  e.preventDefault();
  const errorEl = document.getElementById('login-code-error');
  errorEl.textContent = '';
  const code = document.getElementById('login-code').value.trim();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const res = await Api.post('verifyCustomerLogin', { token: loginPendingToken, code });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not verify the code.';
    return;
  }
  CustomerAuth.saveSession(res.token, res.customer);
  window.location.href = nextDest();
}

function resetLogin() {
  loginPendingToken = null;
  document.getElementById('login-code-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('login-code').value = '';
  document.getElementById('login-code-error').textContent = '';
}

/* ---------- Create account ---------- */

async function onSignupRequest(e) {
  e.preventDefault();
  const errorEl = document.getElementById('signup-error');
  errorEl.textContent = '';
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  if (!name || !email || !phone) {
    errorEl.textContent = 'Please fill in your name, email, and phone number.';
    return;
  }
  if (!isCustomerPhoneValid(phone)) {
    errorEl.textContent = 'Local phone numbers must start with 730 or 630. For an overseas number, include your country code (e.g. +64…).';
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const res = await Api.post('registerCustomer', { name, email, phone });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not send a code. Please try again.';
    return;
  }
  signupPendingToken = res.pendingToken;
  document.getElementById('signup-code-hint').textContent = `We emailed a 6-digit code to ${email}. Enter it below to finish.`;
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('signup-code-form').classList.remove('hidden');
  document.getElementById('signup-code').focus();
}

async function onSignupVerify(e) {
  e.preventDefault();
  const errorEl = document.getElementById('signup-code-error');
  errorEl.textContent = '';
  const code = document.getElementById('signup-code').value.trim();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const res = await Api.post('verifyCustomerEmail', { token: signupPendingToken, code });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not verify the code.';
    return;
  }
  CustomerAuth.saveSession(res.token, res.customer);
  window.location.href = nextDest();
}

function resetSignup() {
  signupPendingToken = null;
  document.getElementById('signup-code-form').classList.add('hidden');
  document.getElementById('signup-form').classList.remove('hidden');
  document.getElementById('signup-code').value = '';
  document.getElementById('signup-code-error').textContent = '';
}
