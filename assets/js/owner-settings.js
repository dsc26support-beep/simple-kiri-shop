document.addEventListener('DOMContentLoaded', init);

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;
  fillForm(owner);

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
