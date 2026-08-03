document.addEventListener('DOMContentLoaded', init);

const DELIVERY_BUTTONS = [
  { id: 'delivery-truck-btn', method: 'truck', label: 'Truck' },
  { id: 'delivery-ship-btn', method: 'ship', label: 'Ship' },
  { id: 'delivery-aircargo-btn', method: 'airCargo', label: 'Air Cargo' }
];

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  document.getElementById('store-name-label').textContent = owner.storeName;

  renderDeliveryToggleButtons();
  wireDeliveryToggles();
  populateIslandSelect();
  wireLocationFields();
  wirePasswordToggle('new-password');

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

  DELIVERY_BUTTONS.forEach(({ id, method }) => {
    const key = 'delivery' + method[0].toUpperCase() + method.slice(1);
    document.getElementById(id).setAttribute('aria-pressed', String(!!owner[key]));
  });

  document.getElementById('settings-island').value = owner.island || '';
  populateVillageSelect(owner.island || '', owner.village || '');
}

function renderDeliveryToggleButtons() {
  DELIVERY_BUTTONS.forEach(({ id, method, label }) => {
    document.getElementById(id).innerHTML = `${DELIVERY_ICON_SVG[method]}<span>${label}</span>`;
  });
}

function wireDeliveryToggles() {
  document.querySelectorAll('.delivery-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!pressed));
    });
  });
}

function populateIslandSelect() {
  const select = document.getElementById('settings-island');
  select.innerHTML = ['<option value="">Select an island…</option>']
    .concat(Object.keys(KIRIBATI_ISLANDS).map((island) => `<option value="${escapeHtml(island)}">${escapeHtml(island)}</option>`))
    .join('');
}

function populateVillageSelect(island, selectedVillage) {
  const villageSelect = document.getElementById('settings-village');
  const otherField = document.getElementById('settings-village-other-field');
  const otherInput = document.getElementById('settings-village-other');
  const villages = KIRIBATI_ISLANDS[island] || [];

  villageSelect.innerHTML = ['<option value="">Select a village…</option>']
    .concat(villages.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
    .concat([`<option value="${escapeHtml(KIRIBATI_OTHER_VILLAGE)}">${escapeHtml(KIRIBATI_OTHER_VILLAGE)}</option>`])
    .join('');

  if (selectedVillage && villages.indexOf(selectedVillage) !== -1) {
    villageSelect.value = selectedVillage;
    otherField.classList.add('hidden');
    otherInput.value = '';
  } else if (selectedVillage) {
    villageSelect.value = KIRIBATI_OTHER_VILLAGE;
    otherField.classList.remove('hidden');
    otherInput.value = selectedVillage;
  } else {
    villageSelect.value = '';
    otherField.classList.add('hidden');
    otherInput.value = '';
  }
}

function wireLocationFields() {
  document.getElementById('settings-island').addEventListener('change', (e) => {
    populateVillageSelect(e.target.value, '');
  });

  document.getElementById('settings-village').addEventListener('change', (e) => {
    const otherField = document.getElementById('settings-village-other-field');
    if (e.target.value === KIRIBATI_OTHER_VILLAGE) {
      otherField.classList.remove('hidden');
    } else {
      otherField.classList.add('hidden');
      document.getElementById('settings-village-other').value = '';
    }
  });
}

async function onSaveSettings(e) {
  e.preventDefault();
  const errorEl = document.getElementById('settings-error');
  const successEl = document.getElementById('settings-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const villageSelectValue = document.getElementById('settings-village').value;
  const village =
    villageSelectValue === KIRIBATI_OTHER_VILLAGE
      ? document.getElementById('settings-village-other').value.trim()
      : villageSelectValue;

  const payload = {
    token: Auth.getToken(),
    storeName: document.getElementById('store-name').value.trim(),
    email: document.getElementById('contact-email').value.trim(),
    phone: document.getElementById('contact-phone').value.trim(),
    island: document.getElementById('settings-island').value,
    village: village
  };

  DELIVERY_BUTTONS.forEach(({ id, method }) => {
    payload['delivery' + method[0].toUpperCase() + method.slice(1)] = document.getElementById(id).getAttribute('aria-pressed') === 'true';
  });

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
