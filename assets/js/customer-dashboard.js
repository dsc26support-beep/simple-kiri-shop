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

  wireDashActions();
  loadOrders();
  loadBookings();

  // After first paint, and after the two lists that people actually came for.
  // Nothing on screen depends on the answer, so it must not compete with them.
  whenIdle(resolveStoreLink);
}

/**
 * Swap "Create Store" to "My Store" when this customer's email already owns
 * one. The backend decides - it checks the signed-in customer's OWN address
 * and never an address supplied by the page, so this cannot be used to find
 * out which addresses belong to vendors.
 *
 * Only the label and the destination change. The button's box is sized to
 * "Create Store", the wider of the two, so the swap cannot move anything -
 * including sideways, which counts towards CLS exactly as a vertical shift
 * does.
 */
async function resolveStoreLink() {
  const link = document.getElementById('store-link');
  if (!link) return;
  let res;
  try {
    res = await Api.post('getCustomerStore', { token: CustomerAuth.getToken() });
  } catch (e) {
    return; // leave "Create Store" - the honest default when we cannot tell
  }
  if (!res || !res.ok || !res.hasStore) return;
  link.textContent = 'My Store';
  link.href = 'owner/dashboard.html';
  if (res.storeName) link.setAttribute('title', res.storeName);
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
  // Feedback on the very first frame. Even with the grace period in
  // CustomerAuth.logout, a second of silence after a tap reads as a dead
  // button - which is exactly how this was reported.
  const btn = document.getElementById('customer-logout');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Logging out<span class="btn-saving-dots"><span></span><span></span><span></span></span>';
  }
  await CustomerAuth.logout();
  window.location.href = 'index.html';
}

/* ---------- Orders & bookings ----------
 *
 * One list per section, fetched once and then filtered in memory: the whole
 * set is already here, so a filter tap is a re-render, not a request. Only
 * "Archived" goes back to the backend, because archived rows are deliberately
 * not in the default payload.
 *
 * What may be edited or removed is decided by the backend, which sends canEdit
 * and canArchive per row. This file only draws them. That split matters: a
 * button hidden here is a courtesy, not a rule - the same conditions are
 * re-checked server-side on every write, so a crafted request gets the same
 * refusal an honest one would.
 */

let allOrders = [];
let allBookings = [];
let ordersFilter = 'All';
let bookingsFilter = 'All';
let archivedOrdersLoaded = false;
let archivedBookingsLoaded = false;
// Guards against a double-tap sending two writes for the same record.
const pending = {};

const ARCHIVED = 'Archived';

/* ---------- Orders ---------- */

async function loadOrders(opts) {
  const statusEl = document.getElementById('orders-status');
  const listEl = document.getElementById('orders-list');
  const stop = startLoadingMessage(statusEl);
  const includeArchived = !!(opts && opts.includeArchived);
  const res = await Api.post('listCustomerOrders', {
    token: CustomerAuth.getToken(),
    includeArchived: includeArchived
  });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  if (includeArchived) archivedOrdersLoaded = true;
  allOrders = res.orders || [];
  renderOrderFilters();
  renderOrders();
}

// Only the statuses this customer actually has, so the row never fills with
// tabs that lead nowhere. Archived is offered once there is something in it,
// or once they have archived something this session.
function renderOrderFilters() {
  const present = [];
  allOrders.forEach((o) => {
    if (o.archived) return;
    if (o.status && present.indexOf(o.status) === -1) present.push(o.status);
  });
  const hasArchived = archivedOrdersLoaded ? allOrders.some((o) => o.archived) : true;
  renderFilters('orders-filters', ['All'].concat(present, hasArchived ? [ARCHIVED] : []),
    ordersFilter, (v) => {
      ordersFilter = v;
      // Archived rows are not in the default payload, so the first visit to
      // that tab needs one fetch. After that it is in memory like the rest.
      if (v === ARCHIVED && !archivedOrdersLoaded) {
        loadOrders({ includeArchived: true });
        return;
      }
      renderOrderFilters();
      renderOrders();
    });
}

function visibleOrders() {
  if (ordersFilter === ARCHIVED) return allOrders.filter((o) => o.archived);
  const live = allOrders.filter((o) => !o.archived);
  return ordersFilter === 'All' ? live : live.filter((o) => o.status === ordersFilter);
}

function renderOrders() {
  const statusEl = document.getElementById('orders-status');
  const listEl = document.getElementById('orders-list');
  const rows = visibleOrders();
  if (rows.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = allOrders.length === 0
      ? 'No orders yet.'
      : (ordersFilter === ARCHIVED ? 'Nothing removed from your list.' : `No ${ordersFilter.toLowerCase()} orders.`);
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = rows.map(orderRow).join('');
}

function orderRow(o) {
  const id = escapeHtml(o.orderId);
  return `
    <div class="dash-item" data-order-id="${id}">
      <div class="dash-item-main">
        <strong>${escapeHtml(o.storeName || o.storeSlug || 'Store')}</strong>
        <span class="helper-text">${escapeHtml(o.itemsSummary || '')}</span>
        ${dashActions(o.archived, o.canEdit, o.canArchive, 'order', id,
          'This order can no longer be edited.')}
        <p class="dash-item-error form-error" id="order-error-${id}" role="alert"></p>
      </div>
      <div class="dash-item-side">
        <strong>${formatMoney(o.total)}</strong>
        <span class="dash-status">${escapeHtml(o.status || '')}</span>
      </div>
    </div>`;
}

/* ---------- Bookings ---------- */

async function loadBookings(opts) {
  const statusEl = document.getElementById('bookings-status');
  const listEl = document.getElementById('bookings-list');
  const stop = startLoadingMessage(statusEl);
  const includeArchived = !!(opts && opts.includeArchived);
  const res = await Api.post('listCustomerBookings', {
    token: CustomerAuth.getToken(),
    includeArchived: includeArchived
  });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  if (includeArchived) archivedBookingsLoaded = true;
  allBookings = res.bookings || [];
  renderBookingFilters();
  renderBookings();
}

function renderBookingFilters() {
  const present = [];
  allBookings.forEach((b) => {
    if (b.archived) return;
    if (b.status && present.indexOf(b.status) === -1) present.push(b.status);
  });
  const hasArchived = archivedBookingsLoaded ? allBookings.some((b) => b.archived) : true;
  renderFilters('bookings-filters', ['All'].concat(present, hasArchived ? [ARCHIVED] : []),
    bookingsFilter, (v) => {
      bookingsFilter = v;
      if (v === ARCHIVED && !archivedBookingsLoaded) {
        loadBookings({ includeArchived: true });
        return;
      }
      renderBookingFilters();
      renderBookings();
    });
}

function visibleBookings() {
  if (bookingsFilter === ARCHIVED) return allBookings.filter((b) => b.archived);
  const live = allBookings.filter((b) => !b.archived);
  return bookingsFilter === 'All' ? live : live.filter((b) => b.status === bookingsFilter);
}

function renderBookings() {
  const statusEl = document.getElementById('bookings-status');
  const listEl = document.getElementById('bookings-list');
  const rows = visibleBookings();
  if (rows.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = allBookings.length === 0
      ? 'No bookings yet.'
      : (bookingsFilter === ARCHIVED ? 'Nothing removed from your list.' : `No ${bookingsFilter.toLowerCase()} bookings.`);
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = rows.map(bookingRow).join('');
}

function bookingRow(b) {
  const id = escapeHtml(b.bookingId);
  const dates = [b.startDate, b.endDate].filter(Boolean).join(' → ');
  return `
    <div class="dash-item" data-booking-id="${id}">
      <div class="dash-item-main">
        <strong>${escapeHtml(b.productName || 'Booking')}</strong>
        <span class="helper-text">${escapeHtml(b.storeName || b.storeSlug || '')}${dates ? ' · ' + escapeHtml(dates) : ''}</span>
        ${dashActions(b.archived, b.canEdit, b.canArchive, 'booking', id,
          'This booking can no longer be edited.')}
        <p class="dash-item-error form-error" id="booking-error-${id}" role="alert"></p>
      </div>
      <div class="dash-item-side">
        <span class="dash-status">${escapeHtml(b.status || '')}</span>
      </div>
    </div>`;
}

/* ---------- Shared bits ---------- */

// Plain buttons in the existing .btn/.btn-small style - no new component, and
// nothing shown that the backend has not said is allowed.
function dashActions(archived, canEdit, canArchive, kind, id, lockedNote) {
  if (archived) {
    return `<p class="dash-item-actions">
      <button type="button" class="btn btn-small" data-restore="${kind}" data-id="${id}">Put back</button>
    </p>`;
  }
  const parts = [];
  if (canEdit) parts.push(`<button type="button" class="btn btn-small" data-edit="${kind}" data-id="${id}">Edit</button>`);
  if (canArchive) parts.push(`<button type="button" class="btn btn-small" data-archive="${kind}" data-id="${id}">Remove</button>`);
  if (parts.length === 0) {
    return `<p class="dash-item-locked helper-text">${escapeHtml(lockedNote)}</p>`;
  }
  return `<p class="dash-item-actions">${parts.join(' ')}</p>`;
}

function renderFilters(containerId, values, active, onPick) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = values.map((v) => `
    <button type="button" class="dash-filter${v === active ? ' is-active' : ''}"
            data-filter="${escapeHtml(v)}" aria-pressed="${v === active ? 'true' : 'false'}">${escapeHtml(v)}</button>
  `).join('');
  el.onclick = (e) => {
    const btn = e.target.closest('.dash-filter');
    if (btn) onPick(btn.dataset.filter);
  };
}

// One delegated listener for both lists, bound once - the rows are re-rendered
// constantly and per-row listeners would be re-attached on every filter tap.
function wireDashActions() {
  document.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return openEditForm(edit.dataset.edit, edit.dataset.id);
    const archive = e.target.closest('[data-archive]');
    if (archive) return onArchive(archive.dataset.archive, archive.dataset.id, true);
    const restore = e.target.closest('[data-restore]');
    if (restore) return onArchive(restore.dataset.restore, restore.dataset.id, false);
    const cancel = e.target.closest('[data-cancel-edit]');
    if (cancel) return (kindOf(cancel) === 'order' ? renderOrders() : renderBookings());
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-edit-form]');
    if (form) onSaveEdit(e, form);
  });
}

const kindOf = (el) => el.getAttribute('data-cancel-edit');

/**
 * Replaces the row's body with a small inline form. Inline rather than a modal
 * because the Account page has no modal of its own, and adding one for two
 * fields would be a new component where an existing pattern (the profile
 * editor directly above, which also swaps view for form in place) already
 * does the job.
 */
function openEditForm(kind, id) {
  const isOrder = kind === 'order';
  const rec = isOrder
    ? allOrders.find((o) => o.orderId === id)
    : allBookings.find((b) => b.bookingId === id);
  if (!rec) return;

  const row = document.querySelector(isOrder ? `[data-order-id="${CSS.escape(id)}"]` : `[data-booking-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const main = row.querySelector('.dash-item-main');

  const common = `
    <label class="sr-only" for="edit-name-${id}">Your name</label>
    <input id="edit-name-${id}" name="customerName" class="dash-edit-input" placeholder="Your name" value="${escapeHtml(rec.customerName || '')}" required>
    <label class="sr-only" for="edit-phone-${id}">Phone number</label>
    <input id="edit-phone-${id}" name="customerPhone" class="dash-edit-input" placeholder="Phone number" inputmode="tel" value="${escapeHtml(rec.customerPhone || '')}" required>`;

  const specific = isOrder
    ? `<label class="sr-only" for="edit-island-${id}">Island</label>
       <input id="edit-island-${id}" name="island" class="dash-edit-input" placeholder="Island" value="${escapeHtml(rec.island || '')}">
       <label class="sr-only" for="edit-village-${id}">Village</label>
       <input id="edit-village-${id}" name="village" class="dash-edit-input" placeholder="Village" value="${escapeHtml(rec.village || '')}">`
    : `<label class="dash-edit-label" for="edit-start-${id}">Pick-up date</label>
       <input id="edit-start-${id}" name="startDate" class="dash-edit-input" type="date" value="${escapeHtml(rec.startDate || '')}" required>
       <label class="dash-edit-label" for="edit-end-${id}">Return date</label>
       <input id="edit-end-${id}" name="endDate" class="dash-edit-input" type="date" value="${escapeHtml(rec.endDate || '')}" required>`;

  main.innerHTML = `
    <form class="dash-edit-form" data-edit-form data-kind="${kind}" data-id="${escapeHtml(id)}">
      ${common}
      ${specific}
      <label class="sr-only" for="edit-notes-${id}">Notes</label>
      <textarea id="edit-notes-${id}" name="notes" class="dash-edit-input" placeholder="Notes (optional)">${escapeHtml(rec.notes || '')}</textarea>
      <p class="dash-edit-actions">
        <button type="submit" class="btn btn-primary btn-small">Save</button>
        <button type="button" class="btn btn-small" data-cancel-edit="${kind}">Cancel</button>
      </p>
      <p class="form-error" data-edit-error role="alert"></p>
    </form>`;
  main.querySelector('.dash-edit-input').focus();
}

async function onSaveEdit(e, form) {
  e.preventDefault();
  const kind = form.dataset.kind;
  const id = form.dataset.id;
  const errorEl = form.querySelector('[data-edit-error]');
  const submit = form.querySelector('button[type="submit"]');
  errorEl.textContent = '';

  const key = `${kind}:${id}`;
  if (pending[key]) return;
  pending[key] = true;
  submit.disabled = true;

  const fd = new FormData(form);
  const payload = { token: CustomerAuth.getToken() };
  fd.forEach((v, k) => { payload[k] = String(v).trim(); });

  const isOrder = kind === 'order';
  if (isOrder) payload.orderId = id; else payload.bookingId = id;

  const res = await Api.post(isOrder ? 'updateCustomerOrder' : 'updateCustomerBooking', payload);
  pending[key] = false;
  submit.disabled = false;

  if (!res.ok) {
    // The backend's message is the honest one - it knows the status now, and
    // this page may have been open for a while.
    errorEl.textContent = res.error || 'Could not save your changes.';
    return;
  }

  await showOrderSentPopup('Saved', 900);
  if (isOrder) await loadOrders({ includeArchived: archivedOrdersLoaded });
  else await loadBookings({ includeArchived: archivedBookingsLoaded });
}

async function onArchive(kind, id, archived) {
  const isOrder = kind === 'order';
  if (archived) {
    const what = isOrder ? 'order' : 'booking';
    const yes = confirm(
      `Remove this ${what} from your account history? The transaction stays securely recorded, ` +
      `and the store still sees it - it just leaves your list. You can put it back from the Archived filter.`);
    if (!yes) return;
  }

  const key = `${kind}:${id}`;
  if (pending[key]) return;
  pending[key] = true;

  const payload = { token: CustomerAuth.getToken(), archived: archived };
  if (isOrder) payload.orderId = id; else payload.bookingId = id;
  const res = await Api.post(isOrder ? 'setCustomerOrderArchived' : 'setCustomerBookingArchived', payload);
  pending[key] = false;

  if (!res.ok) {
    const errorEl = document.getElementById(`${isOrder ? 'order' : 'booking'}-error-${id}`);
    if (errorEl) errorEl.textContent = res.error || 'Could not update this record.';
    return;
  }

  await showOrderSentPopup(archived ? 'Removed from your list' : 'Put back', 900);
  if (isOrder) await loadOrders({ includeArchived: archivedOrdersLoaded });
  else await loadBookings({ includeArchived: archivedBookingsLoaded });
}
