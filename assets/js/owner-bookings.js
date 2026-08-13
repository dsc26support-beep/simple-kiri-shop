document.addEventListener('DOMContentLoaded', init);

// Mirrors apps-script/Bookings.gs's BOOKING_TRANSITIONS - the server is the
// source of truth (see actionUpdateBookingStatus's lock-guarded overlap
// re-check), this just keeps the UI from ever offering a doomed transition.
const BOOKING_TRANSITIONS = {
  Pending: ['Confirmed', 'Declined'],
  Confirmed: ['Cancelled']
};
const BOOKINGS_PAGE_SIZE = 20;
let ownerBookings = [];
let bookingsHasMore = false;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('booking-list').addEventListener('change', onStatusChange);
  document.getElementById('bookings-load-more').addEventListener('click', onLoadMore);
  await loadBookings();
}

/** Same growing-limit reload pattern as loadOrders (owner-orders.js) - see that file's comment. */
async function loadBookings(opts) {
  const limit = (opts && opts.limit) || ownerBookings.length || BOOKINGS_PAGE_SIZE;
  const statusEl = document.getElementById('bookings-status');
  const stopLoading = startLoadingMessage(statusEl);
  const res = await Api.post('listOwnerBookings', { token: Auth.getToken(), limit });
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  ownerBookings = res.bookings;
  bookingsHasMore = !!res.hasMore;
  statusEl.textContent = ownerBookings.length === 0 ? 'No booking requests yet.' : `${ownerBookings.length} of ${res.total} booking(s) shown.`;
  document.getElementById('bookings-load-more').classList.toggle('hidden', !bookingsHasMore);
  render();
}

function onLoadMore() {
  loadBookings({ limit: ownerBookings.length + BOOKINGS_PAGE_SIZE });
}

function statusClass(status) {
  return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
}

function formatDateRange(startDate, endDate) {
  const fmt = (d) => new Date(d).toLocaleDateString();
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

function render() {
  const listEl = document.getElementById('booking-list');
  listEl.innerHTML = ownerBookings
    .map((b) => {
      const allowedTargets = BOOKING_TRANSITIONS[b.status] || [];
      const statusControl = allowedTargets.length
        ? `<label class="sr-only" for="status-${escapeHtml(b.bookingId)}">Update status for booking ${escapeHtml(b.bookingId)}</label>
           <select id="status-${escapeHtml(b.bookingId)}" class="booking-status-select" style="width:auto; min-height:36px;">
             <option value="${b.status}" selected>${b.status}</option>
             ${allowedTargets.map((s) => `<option value="${s}">${s}</option>`).join('')}
           </select>`
        : `<span class="status-badge ${statusClass(b.status)}">${escapeHtml(b.status)}</span>`;

      return `
        <article class="order-card" data-booking-id="${escapeHtml(b.bookingId)}">
          <div class="order-card-header">
            <div>
              <strong>${escapeHtml(b.bookingId)}</strong>
              <span class="status-badge ${statusClass(b.status)}">${escapeHtml(b.status)}</span>
              ${b.overlapsConfirmed ? '<span class="status-badge status-declined">Dates already booked elsewhere — consider declining</span>' : ''}
            </div>
            ${statusControl}
          </div>
          <dl>
            <dt>Listing</dt><dd>${escapeHtml(b.productName)} — ${escapeHtml(b.rateLabel)} (${formatMoney(b.ratePrice)})</dd>
            <dt>Dates</dt><dd>${formatDateRange(b.startDate, b.endDate)}</dd>
            <dt>Customer</dt><dd>${escapeHtml(b.customerName)}</dd>
            <dt>Phone</dt><dd>${escapeHtml(b.customerPhone)}</dd>
            ${b.customerEmail ? `<dt>Email</dt><dd>${escapeHtml(b.customerEmail)}</dd>` : ''}
            ${(b.island || b.village) ? `<dt>Location</dt><dd>${escapeHtml([b.village, b.island].filter(Boolean).join(', '))}</dd>` : ''}
            <dt>Requested</dt><dd>${escapeHtml(new Date(b.createdAt).toLocaleString())}</dd>
            ${b.notes ? `<dt>Notes</dt><dd>${escapeHtml(b.notes)}</dd>` : ''}
          </dl>
        </article>
      `;
    })
    .join('');
}

async function onStatusChange(e) {
  if (!e.target.classList.contains('booking-status-select')) return;
  const card = e.target.closest('.order-card');
  const bookingId = card.dataset.bookingId;
  const status = e.target.value;
  if (!BOOKING_TRANSITIONS[ownerBookings.find((b) => b.bookingId === bookingId).status].includes(status)) return;

  const res = await Api.post('updateBookingStatus', { token: Auth.getToken(), bookingId, status });
  if (!res.ok) {
    alert(res.error || 'Could not update this booking - it may conflict with another already-confirmed booking. Reloading the latest state.');
    await loadBookings();
    return;
  }
  await loadBookings({ limit: ownerBookings.length });
}
