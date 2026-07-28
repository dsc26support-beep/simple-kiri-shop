document.addEventListener('DOMContentLoaded', init);

const STATUS_OPTIONS = ['Pending Payment', 'Paid', 'Fulfilled', 'Cancelled'];
let ownerOrders = [];

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('order-list').addEventListener('change', onStatusChange);
  await loadOrders();
}

async function loadOrders() {
  const statusEl = document.getElementById('orders-status');
  statusEl.textContent = 'Loading…';
  const res = await Api.post('listOwnerOrders', { token: Auth.getToken() });
  if (!res.ok) {
    statusEl.textContent = res.error || 'Could not load orders.';
    return;
  }
  ownerOrders = res.orders;
  statusEl.textContent = ownerOrders.length === 0 ? 'No orders yet.' : `${ownerOrders.length} order(s).`;
  render();
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
            <dt>Payment</dt><dd>${escapeHtml(o.paymentMethod)}</dd>
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
