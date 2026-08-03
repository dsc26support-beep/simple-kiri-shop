document.addEventListener('DOMContentLoaded', init);

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;
  fillForm(owner);
  renderTwoFAStatus(owner);
  wireTwoFA();

  document.getElementById('settings-form').addEventListener('submit', onSaveSettings);
  document.getElementById('password-form').addEventListener('submit', onChangePassword);
}

function fillForm(owner) {
  document.getElementById('store-name').value = owner.storeName || '';
  document.getElementById('contact-email').value = owner.email || '';
  document.getElementById('contact-phone').value = owner.phone || '';
  document.getElementById('anz-account-name').value = owner.anzAccountName || '';
  document.getElementById('anz-account-number').value = owner.anzAccountNumber || '';
  document.getElementById('anz-branch').value = owner.anzBranch || '';
  document.getElementById('teremo-number').value = owner.teremoNumber || '';
  document.getElementById('teremo-name').value = owner.teremoName || '';
  document.getElementById('payment-notes').value = owner.paymentNotes || '';
}

async function onSaveSettings(e) {
  e.preventDefault();
  const errorEl = document.getElementById('settings-error');
  const successEl = document.getElementById('settings-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const payload = {
    token: Auth.getToken(),
    storeName: document.getElementById('store-name').value.trim(),
    email: document.getElementById('contact-email').value.trim(),
    phone: document.getElementById('contact-phone').value.trim(),
    anzAccountName: document.getElementById('anz-account-name').value.trim(),
    anzAccountNumber: document.getElementById('anz-account-number').value.trim(),
    anzBranch: document.getElementById('anz-branch').value.trim(),
    teremoNumber: document.getElementById('teremo-number').value.trim(),
    teremoName: document.getElementById('teremo-name').value.trim(),
    paymentNotes: document.getElementById('payment-notes').value.trim()
  };

  const res = await Api.post('updateOwnerProfile', payload);
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not save your settings.';
    return;
  }

  Auth.saveSession(Auth.getToken(), res.owner);
  document.getElementById('store-name-label').textContent = res.owner.storeName;
  successEl.textContent = 'Settings saved.';
  setTimeout(() => { successEl.textContent = ''; }, 3000);
}

async function onChangePassword(e) {
  e.preventDefault();
  const errorEl = document.getElementById('password-error');
  const successEl = document.getElementById('password-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const newPassword = document.getElementById('new-password').value;
  if (!newPassword) {
    errorEl.textContent = 'Enter a new password first.';
    return;
  }
  if (newPassword.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    return;
  }

  const res = await Api.post('updateOwnerProfile', { token: Auth.getToken(), newPassword });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not update your password.';
    return;
  }

  document.getElementById('new-password').value = '';
  successEl.textContent = 'Password updated.';
  setTimeout(() => { successEl.textContent = ''; }, 3000);
}

function renderTwoFAStatus(owner) {
  const statusEl = document.getElementById('twofa-status');
  const enableBtn = document.getElementById('twofa-enable-btn');
  const disableBtn = document.getElementById('twofa-disable-btn');

  if (owner.twoFAEnabled) {
    statusEl.textContent = '2FA is currently ON. You’ll be emailed a code each time you log in.';
    enableBtn.classList.add('hidden');
    disableBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = owner.email
      ? '2FA is currently OFF.'
      : '2FA is currently OFF. Add a contact email above and save settings before enabling 2FA.';
    enableBtn.classList.remove('hidden');
    disableBtn.classList.add('hidden');
  }
}

function wireTwoFA() {
  document.getElementById('twofa-enable-btn').addEventListener('click', onRequestEnable2FA);
  document.getElementById('twofa-disable-btn').addEventListener('click', onDisable2FA);
  document.getElementById('twofa-cancel-btn').addEventListener('click', () => {
    document.getElementById('twofa-confirm-form').classList.add('hidden');
  });
  document.getElementById('twofa-confirm-form').addEventListener('submit', onConfirm2FA);
}

async function onRequestEnable2FA() {
  const errorEl = document.getElementById('twofa-action-error');
  errorEl.textContent = '';

  const res = await Api.post('enable2FARequest', { token: Auth.getToken() });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not send a verification code.';
    return;
  }

  document.getElementById('twofa-verify-token').value = res.verifyToken;
  document.getElementById('twofa-confirm-form').classList.remove('hidden');
  document.getElementById('twofa-confirm-code').focus();
}

async function onConfirm2FA(e) {
  e.preventDefault();
  const errorEl = document.getElementById('twofa-confirm-error');
  errorEl.textContent = '';

  const verifyToken = document.getElementById('twofa-verify-token').value;
  const code = document.getElementById('twofa-confirm-code').value.trim();

  const res = await Api.post('confirm2FASetup', { token: Auth.getToken(), verifyToken, code });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not confirm that code.';
    return;
  }

  const owner = Auth.getOwner();
  owner.twoFAEnabled = true;
  Auth.saveSession(Auth.getToken(), owner);

  document.getElementById('twofa-confirm-form').classList.add('hidden');
  document.getElementById('twofa-confirm-code').value = '';
  document.getElementById('twofa-action-success').textContent = 'Two-factor authentication is now on.';
  renderTwoFAStatus(owner);
  setTimeout(() => { document.getElementById('twofa-action-success').textContent = ''; }, 3000);
}

async function onDisable2FA() {
  if (!confirm('Turn off two-factor authentication for your store account?')) return;

  const errorEl = document.getElementById('twofa-action-error');
  errorEl.textContent = '';

  const res = await Api.post('disable2FA', { token: Auth.getToken() });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not disable 2FA.';
    return;
  }

  const owner = Auth.getOwner();
  owner.twoFAEnabled = false;
  Auth.saveSession(Auth.getToken(), owner);

  document.getElementById('twofa-action-success').textContent = 'Two-factor authentication is now off.';
  renderTwoFAStatus(owner);
  setTimeout(() => { document.getElementById('twofa-action-success').textContent = ''; }, 3000);
}
