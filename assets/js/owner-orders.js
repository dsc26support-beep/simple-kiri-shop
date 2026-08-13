document.addEventListener('DOMContentLoaded', init);

const STATUS_OPTIONS = ['Pending Payment', 'Paid', 'Fulfilled', 'Cancelled'];
const ORDERS_PAGE_SIZE = 20;
let ownerOrders = [];
let ordersHasMore = false;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('order-list').addEventListener('change', onStatusChange);
  document.getElementById('orders-load-more').addEventListener('click', onLoadMore);
  await loadOrders();
}

/**
 * Re-requests "the top N orders" each time, growing N via Load More rather
 * than a true offset cursor - mirrors the pattern already used for the
 * vendor conversation list (owner-messages.js) and the store directory
 * (directory.js). onStatusChange below never calls this on success (it
 * patches the already-loaded array in place), so a normal status edit never
 * loses pages the vendor had already loaded - only the initial load and the
 * Load More/error-retry paths do.
 */
async function loadOrders(opts) {
  const limit = (opts && opts.limit) || ownerOrders.length || ORDERS_PAGE_SIZE;
  const statusEl = document.getElementById('orders-status');
  const stopLoading = startLoadingMessage(statusEl);
  const res = await Api.post('listOwnerOrders', { token: Auth.getToken(), limit });
  stopLoading();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  ownerOrders = res.orders;
  ordersHasMore = !!res.hasMore;
  statusEl.textContent = ownerOrders.length === 0 ? 'No orders yet.' : `${ownerOrders.length} of ${res.total} order(s) shown.`;
  document.getElementById('orders-load-more').classList.toggle('hidden', !ordersHasMore);
  render();
}

function onLoadMore() {
  loadOrders({ limit: ownerOrders.length + ORDERS_PAGE_SIZE });
}

function statusClass(status) {
  return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
}

function render() {
  const listEl = document.getElementById('order-list');
  listEl.innerHTML = ownerOrders
    .map((o) => {
      const options = STATUS_OPTIONS.map(
        (s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`
      ).join('');
      return `
        <article class="order-card" data-order-id="${escapeHtml(o.orderId)}">
          <div class="order-card-header">
            <div>
              <strong>${escapeHtml(o.orderId)}</strong>
              <span class="status-badge ${statusClass(o.status)}">${escapeHtml(o.status)}</span>
            </div>
            <label class="sr-only" for="status-${escapeHtml(o.orderId)}">Update status for order ${escapeHtml(o.orderId)}</label>
            <select id="status-${escapeHtml(o.orderId)}" class="order-status-select" style="width:auto; min-height:36px;">${options}</select>
          </div>
          <dl>
            <dt>Customer</dt><dd>${escapeHtml(o.customerName)}</dd>
            <dt>Phone</dt><dd>${escapeHtml(o.customerPhone)}</dd>
            ${o.deliveryAddress ? `<dt>Address</dt><dd>${escapeHtml(o.deliveryAddress)}</dd>` : ''}
            ${o.deliveryMethod ? `<dt>Delivery</dt><dd>${escapeHtml(DELIVERY_ICON_LABELS[o.deliveryMethod] || o.deliveryMethod)}${o.deliveryCost != null ? ' — ' + (Number(o.deliveryCost) === 0 ? 'Free' : formatMoney(o.deliveryCost)) : ''}</dd>` : ''}
            <dt>Payment</dt><dd>${o.paymentMethod ? escapeHtml(o.paymentMethod) : 'Not yet specified'}</dd>
            <dt>Items</dt><dd>${escapeHtml(o.itemsSummary)}</dd>
            <dt>Total</dt><dd>${formatMoney(o.total)}</dd>
            <dt>Placed</dt><dd>${escapeHtml(new Date(o.createdAt).toLocaleString())}</dd>
            ${o.notes ? `<dt>Notes</dt><dd>${escapeHtml(o.notes)}</dd>` : ''}
          </dl>
        </article>
      `;
    })
    .join('');
}

async function onStatusChange(e) {
  if (!e.target.classList.contains('order-status-select')) return;
  const card = e.target.closest('.order-card');
  const orderId = card.dataset.orderId;
  const status = e.target.value;

  const res = await Api.post('updateOrderStatus', { token: Auth.getToken(), orderId, status });
  if (!res.ok) {
    alert(res.error || 'Could not update this order.');
    await loadOrders();
    return;
  }
  const order = ownerOrders.find((o) => o.orderId === orderId);
  if (order) order.status = status;
  render();
}
