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

  prefillRememberedEmail();
  wireInfoDot('guest-info-btn', 'guest-info');
  wireInfoDot('shared-info-btn', 'shared-info');
}

/**
 * An "i" dot and the panel it reveals. Used twice on this page - beside
 * Continue as guest, and beside the shared-device checkbox.
 *
 * A tooltip on a phone has to be dismissible by every route someone will
 * actually try: tapping the dot again, tapping anywhere else, or Escape. A
 * popup that can only be closed by hitting the same 32px target is a trap.
 *
 * Opening one closes any other that is open - two panels overlapping on a
 * 390px screen is unreadable.
 *
 * The panel is absolutely positioned (see .info-pop), so opening it moves
 * nothing - a panel that shoved the form down on every tap would be a layout
 * shift on interaction, which is the same defect as one on load, just later.
 */
function wireInfoDot(btnId, popId) {
  const btn = document.getElementById(btnId);
  const pop = document.getElementById(popId);
  if (!btn || !pop) return;

  const setOpen = (open) => {
    pop.classList.remove('info-pop--above');
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;

    // Flip above the dot when there is no room below. The shared-device dot
    // sits near the bottom of the card, and on a 640px-tall screen the panel
    // opened 95px below the fold - a tap that appeared to do nothing.
    // Measured and flipped in the same frame as the reveal, so the browser
    // only ever paints the final position; nothing flashes.
    const box = pop.getBoundingClientRect();
    if (box.bottom > window.innerHeight && box.height < btn.getBoundingClientRect().top) {
      pop.classList.add('info-pop--above');
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();          // or the document handler below closes it again
    const opening = pop.hidden;
    closeAllInfoPops();
    setOpen(opening);
  });

  document.addEventListener('click', (e) => {
    if (pop.hidden) return;
    if (!pop.contains(e.target)) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      setOpen(false);
      btn.focus();                // don't strand the keyboard user mid-page
    }
  });
}

/**
 * The address this device signed in with last time. Filling it in saves typing
 * it again on a phone keyboard, which is the whole point; showing it with a way
 * out matters because these phones get shared.
 *
 * An email address alone signs nobody in - the six-digit code still has to
 * reach that mailbox - so remembering it is a convenience, not a credential.
 */
function prefillRememberedEmail() {
  const email = CustomerAuth.getRememberedEmail && CustomerAuth.getRememberedEmail();
  if (!email) return;

  const input = document.getElementById('login-email');
  const note = document.getElementById('login-remembered');
  const shown = document.getElementById('login-remembered-email');
  if (!input || !note || !shown) return;

  // Visibility was already decided before first paint by the inline script in
  // the head (see customer-login.html). This only fills in the text, which
  // changes the line's width and not its height, so nothing moves.
  input.value = email;
  shown.textContent = email;

  document.getElementById('login-not-you').addEventListener('click', () => {
    CustomerAuth.forgetEmail();
    input.value = '';
    document.documentElement.classList.remove('has-remembered-email');
    input.focus();
  });
}

// Where to go after a successful sign in. Supports ?next= for returning to a
// page (e.g. checkout), but only same-site relative paths - never an absolute
// or off-site URL (open-redirect guard).
/**
 * "This is a shared device" - phones get shared here, and order history carries
 * names, phone numbers and delivery addresses. Ticked, the backend issues a
 * 12-hour session instead of the 60-day one. Read at submit time rather than
 * cached, so changing the box before submitting does what it looks like it does.
 */
function sharedDeviceChecked() {
  const box = document.getElementById('shared-device');
  return !!(box && box.checked);
}

/** Shuts every info panel on the page. Two open at once is unreadable at 390px. */
function closeAllInfoPops() {
  document.querySelectorAll('.info-pop').forEach((p) => { p.hidden = true; });
  document.querySelectorAll('.info-dot').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

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
  const res = await Api.post('verifyCustomerLogin',
    { token: loginPendingToken, code, sharedDevice: sharedDeviceChecked() });
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
  const res = await Api.post('verifyCustomerEmail',
    { token: signupPendingToken, code, sharedDevice: sharedDeviceChecked() });
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
