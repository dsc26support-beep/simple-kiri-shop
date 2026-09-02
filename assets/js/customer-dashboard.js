document.addEventListener('DOMContentLoaded', init);

let currentCustomer = null;

async function init() {
  currentCustomer = await CustomerAuth.guardCustomerAuth();
  if (!currentCustomer) return; // guard already redirected

  renderProfile();
  document.getElementById('customer-logout').addEventListener('click', onLogout);
  document.getElementById('profile-edit-btn').addEventListener('click', () => toggleProfileEdit(true));
  document.getElementById('profile-cancel').addEventListener('click', () => toggleProfileEdit(false));
  document.getElementById('profile-form').addEventListener('submit', onSaveProfile);

  // If they also own a store, offer a jump to the seller side.
  if (typeof Auth !== 'undefined' && Auth.getToken()) {
    document.getElementById('seller-link-wrap').classList.remove('hidden');
  }

  loadOrders();
  loadBookings();
}

/* ---------- Profile ---------- */

function renderProfile() {
  document.getElementById('profile-name').textContent = currentCustomer.name || '';
  document.getElementById('profile-email').textContent = currentCustomer.email || '';
  document.getElementById('profile-phone').textContent = currentCustomer.phone || '';
}

function toggleProfileEdit(editing) {
  document.getElementById('profile-view').classList.toggle('hidden', editing);
  document.getElementById('profile-form').classList.toggle('hidden', !editing);
  if (editing) {
    document.getElementById('profile-name-input').value = currentCustomer.name || '';
    document.getElementById('profile-phone-input').value = currentCustomer.phone || '';
    document.getElementById('profile-error').textContent = '';
  }
}

async function onSaveProfile(e) {
  e.preventDefault();
  const errorEl = document.getElementById('profile-error');
  errorEl.textContent = '';
  const name = document.getElementById('profile-name-input').value.trim();
  const phone = document.getElementById('profile-phone-input').value.trim();
  if (!name || !phone) {
    errorEl.textContent = 'Please enter your name and phone number.';
    return;
  }
  if (!isCustomerPhoneValid(phone)) {
    errorEl.textContent = 'Local phone numbers must start with 730 or 630. For an overseas number, include your country code (e.g. +64…).';
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const res = await Api.post('updateCustomerProfile', { token: CustomerAuth.getToken(), name, phone });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not save your changes.';
    return;
  }
  currentCustomer = res.customer;
  CustomerAuth.saveSession(CustomerAuth.getToken(), currentCustomer);
  renderProfile();
  toggleProfileEdit(false);
}

async function onLogout() {
  await CustomerAuth.logout();
  window.location.href = 'index.html';
}

/* ---------- Orders ---------- */

async function loadOrders() {
  const statusEl = document.getElementById('orders-status');
  const listEl = document.getElementById('orders-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listCustomerOrders', { token: CustomerAuth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const orders = res.orders || [];
  if (orders.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = 'No orders yet.';
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = orders.map(orderRow).join('');
}

function orderRow(o) {
  return `
    <div class="dash-item">
      <div class="dash-item-main">
        <strong>${escapeHtml(o.storeName || o.storeSlug || 'Store')}</strong>
        <span class="helper-text">${escapeHtml(o.itemsSummary || '')}</span>
      </div>
      <div class="dash-item-side">
        <strong>${formatMoney(o.total)}</strong>
        <span class="dash-status">${escapeHtml(o.status || '')}</span>
      </div>
    </div>`;
}

/* ---------- Bookings ---------- */

async function loadBookings() {
  const statusEl = document.getElementById('bookings-status');
  const listEl = document.getElementById('bookings-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listCustomerBookings', { token: CustomerAuth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const bookings = res.bookings || [];
  if (bookings.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = 'No bookings yet.';
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = bookings.map(bookingRow).join('');
}

function bookingRow(b) {
  const dates = [b.startDate, b.endDate].filter(Boolean).join(' → ');
  return `
    <div class="dash-item">
      <div class="dash-item-main">
        <strong>${escapeHtml(b.productName || 'Booking')}</strong>
        <span class="helper-text">${escapeHtml(b.storeName || b.storeSlug || '')}${dates ? ' · ' + escapeHtml(dates) : ''}</span>
      </div>
      <div class="dash-item-side">
        <span class="dash-status">${escapeHtml(b.status || '')}</span>
      </div>
    </div>`;
}
