document.addEventListener('DOMContentLoaded', init);

const DELIVERY_BUTTONS = [
  { id: 'delivery-truck-btn', costId: 'delivery-truck-cost', method: 'truck', label: 'Truck' },
  { id: 'delivery-ship-btn', costId: 'delivery-ship-cost', method: 'ship', label: 'Ship' },
  { id: 'delivery-aircargo-btn', costId: 'delivery-aircargo-cost', method: 'airCargo', label: 'Air Cargo' }
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
  document.getElementById('logo-image-input').addEventListener('change', onLogoFileChange);
  document.getElementById('idlicense-image-input').addEventListener('change', onIdLicenseFileChange);

  fillForm(owner);
  renderTwoFAStatus(owner);
  wireTwoFA();
  renderStoreStatus(owner);
  wireStoreStatus();

  document.getElementById('settings-form').addEventListener('submit', onSaveSettings);
  document.getElementById('password-form').addEventListener('submit', onChangePassword);
}

function fillForm(owner) {
  document.getElementById('store-name').value = owner.storeName || '';
  document.getElementById('contact-email').value = owner.email || '';
  document.getElementById('contact-phone').value = owner.phone || '';

  DELIVERY_BUTTONS.forEach(({ id, costId, method }) => {
    const key = 'delivery' + method[0].toUpperCase() + method.slice(1);
    const pressed = !!owner[key];
    document.getElementById(id).setAttribute('aria-pressed', String(pressed));
    const costInput = document.getElementById(costId);
    const cost = owner[key + 'Cost'];
    costInput.value = cost == null ? '' : cost;
    costInput.classList.toggle('hidden', !pressed);
  });

  document.getElementById('settings-island').value = owner.island || '';
  populateVillageSelect(owner.island || '', owner.village || '');

  const logoPreview = document.getElementById('logo-preview');
  if (owner.logoUrl) {
    logoPreview.src = owner.logoUrl;
    logoPreview.classList.remove('hidden');
  }

  const idLicensePreview = document.getElementById('idlicense-preview');
  if (owner.idLicenseUrl) {
    idLicensePreview.src = owner.idLicenseUrl;
    idLicensePreview.classList.remove('hidden');
  }
}

async function onLogoFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('logo-upload-status');
  const preview = document.getElementById('logo-preview');
  statusEl.textContent = 'Uploading logo…';

  try {
    const { base64, mimeType } = await compressImage(file, 512, 0.85);
    const res = await Api.post('uploadStoreLogo', { token: Auth.getToken(), imageBase64: base64, mimeType });
    if (!res.ok) {
      statusEl.textContent = res.error || 'Could not upload logo.';
      return;
    }
    preview.src = res.logoUrl;
    preview.classList.remove('hidden');
    statusEl.textContent = 'Logo updated.';

    const owner = Auth.getOwner();
    owner.logoUrl = res.logoUrl;
    Auth.saveSession(Auth.getToken(), owner);

    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Could not process that image.';
  }
}

async function onIdLicenseFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('idlicense-upload-status');
  const preview = document.getElementById('idlicense-preview');
  statusEl.textContent = 'Uploading…';

  try {
    const { base64, mimeType } = await compressImage(file, 1024, 0.85);
    const res = await Api.post('uploadOwnerIdLicense', { token: Auth.getToken(), imageBase64: base64, mimeType });
    if (!res.ok) {
      statusEl.textContent = res.error || 'Could not upload that photo.';
      return;
    }
    preview.src = res.idLicenseUrl;
    preview.classList.remove('hidden');
    statusEl.textContent = 'Uploaded.';

    const owner = Auth.getOwner();
    owner.idLicenseUrl = res.idLicenseUrl;
    Auth.saveSession(Auth.getToken(), owner);

    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Could not process that image.';
  }
}

function renderDeliveryToggleButtons() {
  DELIVERY_BUTTONS.forEach(({ id, method, label }) => {
    document.getElementById(id).innerHTML = `${DELIVERY_ICON_SVG[method]}<span>${label}</span>`;
  });
}

function wireDeliveryToggles() {
  DELIVERY_BUTTONS.forEach(({ id, costId }) => {
    const btn = document.getElementById(id);
    const costInput = document.getElementById(costId);
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!pressed));
      costInput.classList.toggle('hidden', pressed);
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

const SAVE_SETTINGS_IDLE_HTML = 'Save Settings';
const SAVE_SETTINGS_BUSY_HTML = 'Saving<span class="btn-saving-dots"><span></span><span></span><span></span></span>';

async function onSaveSettings(e) {
  e.preventDefault();
  const errorEl = document.getElementById('settings-error');
  const successEl = document.getElementById('settings-success');
  const saveBtn = document.getElementById('save-settings-btn');
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

  DELIVERY_BUTTONS.forEach(({ id, costId, method }) => {
    const key = 'delivery' + method[0].toUpperCase() + method.slice(1);
    const pressed = document.getElementById(id).getAttribute('aria-pressed') === 'true';
    payload[key] = pressed;
    if (pressed) {
      const raw = document.getElementById(costId).value.trim();
      payload[key + 'Cost'] = raw === '' ? 0 : Math.max(0, parseFloat(raw) || 0);
    }
  });

  saveBtn.disabled = true;
  saveBtn.innerHTML = SAVE_SETTINGS_BUSY_HTML;

  const res = await Api.post('updateOwnerProfile', payload);

  saveBtn.disabled = false;
  saveBtn.innerHTML = SAVE_SETTINGS_IDLE_HTML;

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

function renderStoreStatus(owner) {
  const currentEl = document.getElementById('store-status-current');
  const standbyBtn = document.getElementById('store-status-standby-btn');
  const reactivateBtn = document.getElementById('store-status-reactivate-btn');

  if (owner.status === 'standby') {
    currentEl.textContent = 'Your store is currently in Standby mode — hidden from customers.';
    standbyBtn.classList.add('hidden');
    reactivateBtn.classList.remove('hidden');
  } else {
    currentEl.textContent = 'Your store is currently Active and visible to customers.';
    standbyBtn.classList.remove('hidden');
    reactivateBtn.classList.add('hidden');
  }
}

function wireStoreStatus() {
  document.getElementById('store-status-standby-btn').addEventListener('click', () => onSetStoreStatus('standby'));
  document.getElementById('store-status-reactivate-btn').addEventListener('click', () => onSetStoreStatus('active'));
  document.getElementById('store-status-delete-btn').addEventListener('click', onDeleteStore);
}

async function onSetStoreStatus(status) {
  const errorEl = document.getElementById('store-status-error');
  errorEl.textContent = '';

  if (status === 'standby' && !confirm('Pause your store? Customers won\'t be able to see it until you reactivate.')) return;

  const res = await Api.post('setStoreStatus', { token: Auth.getToken(), status });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not update store status.';
    return;
  }

  const owner = Auth.getOwner();
  owner.status = status;
  Auth.saveSession(Auth.getToken(), owner);
  renderStoreStatus(owner);
}

async function onDeleteStore() {
  const confirmed = confirm(
    'Delete your store? It will disappear from the directory immediately and you\'ll be signed out and unable to log back in. ' +
    'Your data stays on file - contact admin@mwakete.com if you ever need it restored. This cannot be undone from the dashboard.'
  );
  if (!confirmed) return;

  const errorEl = document.getElementById('store-status-error');
  errorEl.textContent = '';

  const res = await Api.post('setStoreStatus', { token: Auth.getToken(), status: 'closed' });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not delete your store.';
    return;
  }

  Auth.clearSession();
  window.location.href = 'login.html?deleted=1';
}
