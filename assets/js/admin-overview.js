// Admin: platform overview at the top of admin.html (backend Dashboards.gs
// getAdminOverview - admin only, checked on the server). One request; every
// number is counted on the server from the real sheets.
const AdminOverview = (() => {
  const $ = (id) => document.getElementById(id);
  let last = null;

  async function load(days) {
    const status = $('ov-status');
    status.innerHTML = loadingMessageHtml();
    const res = await Api.post('getAdminOverview', { token: Auth.getToken(), days });
    // An answer without figures (an old backend, a proxy page) is a failure too.
    if (!res.ok || !res.kpis) {
      status.innerHTML = `${escapeHtml(res.error || 'The overview could not be loaded.')} <button type="button" class="btn btn-small" id="ov-retry">Try again</button>`;
      $('ov-retry').addEventListener('click', () => load(days));
      return;
    }
    last = res;
    status.textContent = '';
    const k = res.kpis;
    $('ov-orders').textContent = k.ordersToday;
    $('ov-orders-sub').textContent = DashUI.change(k.ordersToday, k.ordersYesterday, false);
    $('ov-sales').textContent = formatMoney(k.salesToday);
    $('ov-sales-sub').textContent = DashUI.change(k.salesToday, k.salesYesterday, true);
    $('ov-stores').textContent = k.activeStores;
    $('ov-stores-sub').textContent = `${k.storeTypes.retailer} retail · ${k.storeTypes.wholesaler} wholesale · ${k.storeTypes.distributor} distributor · ${k.newStores} new`;
    $('ov-customers').textContent = k.customers;
    $('ov-customers-sub').textContent = `${k.newCustomers} new in the last ${res.period} days`;
    $('ov-period-total').textContent = `${formatMoney(k.periodSales)} confirmed from ${k.periodOrders} order(s) in the last ${res.period} days. Sales count once the seller confirms payment.`;
    DashUI.salesChart($('ov-chart'), document.querySelector('#ov-chart-table tbody'), res.series);
    renderWork(res.work, k, res.roomsMode);
    renderTop(res.topStores);
    renderRecent(res.recentOrders);
    renderStock(res.stock);
  }

  function renderWork(w, k, roomsMode) {
    const items = [
      [w.openDisputes, 'danger', `${w.openDisputes} open order problem(s)`, '#txa-heading'],
      [w.featurePending, 'warning', `${w.featurePending} featuring payment(s) to review`, '#feature-payments-heading'],
      [w.featureUnmatched, 'warning', `${w.featureUnmatched} approved featuring payment(s) not yet ticked "seen in bank"`, '#feature-payments-heading'],
      [w.reviewOpen, 'warning', `${w.reviewOpen} listing case(s) in the review queue`, '#lr-heading'],
      [w.unverifiedBulk, 'info', `${w.unverifiedBulk} wholesaler/distributor store(s) waiting for a verification call`, '#wholesale-heading'],
      [w.refundsDue, 'info', `${w.refundsDue} cancelled order(s) with a refund still due from the seller`, '#txa-heading'],
      [w.staleUnpaid, 'info', `${w.staleUnpaid} order(s) unpaid for more than 3 days`, '#admin-search-heading']
    ].filter((x) => x[0] > 0);
    const tone = { danger: 'Urgent', warning: 'Review', info: 'Check' };
    $('ov-work').innerHTML = (items.length
      ? items.map(([, t, text, href]) => `<li class="dash-alert is-${t}"><span class="dash-alert-tag">${tone[t]}</span> <a href="${href}">${escapeHtml(text)}</a></li>`).join('')
      : '<li class="dash-empty">Nothing is waiting for an admin.</li>') +
      (roomsMode === 'off' ? '<li class="helper-text">Order rooms are off (Script Property TX_ROOMS), so order problems cannot be reported yet.</li>' : '');
  }

  function renderTop(list) {
    $('ov-export').hidden = !list.length;
    $('ov-top').innerHTML = list.length ? `<table class="dash-table"><thead><tr><th scope="col">Store</th><th scope="col">Orders</th><th scope="col">Confirmed sales</th></tr></thead>
      <tbody>${list.map((s) => `<tr><td data-label="Store"><a href="../store.html?store=${encodeURIComponent(s.storeSlug)}" target="_blank" rel="noopener">${escapeHtml(s.storeName)}</a><span class="dash-table-sub">${escapeHtml(s.storeType)}</span></td>
        <td data-label="Orders">${s.orders}</td><td data-label="Confirmed sales">${formatMoney(s.sales)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="dash-empty">No orders in this period.</p>';
  }

  function renderRecent(list) {
    $('ov-recent').innerHTML = list.length ? `<table class="dash-table"><thead><tr><th scope="col">Order</th><th scope="col">Store</th><th scope="col">Total</th><th scope="col">Status</th></tr></thead>
      <tbody>${list.map((o) => `<tr><td data-label="Order"><a href="../order-room.html?order=${encodeURIComponent(o.orderId)}&amp;as=admin">${escapeHtml(o.orderId)}</a><span class="dash-table-sub">${escapeHtml(new Date(o.createdAt).toLocaleDateString())}</span></td>
        <td data-label="Store">${escapeHtml(o.storeName)}</td><td data-label="Total">${formatMoney(o.total)}</td>
        <td data-label="Status">${DashUI.statusPill(o.status)}${o.problem ? ' <span class="status-badge status-problem">Problem</span>' : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="dash-empty">No orders yet.</p>';
  }

  function renderStock(s) {
    $('ov-stock').innerHTML = `<p>${s.out} variety(ies) out of stock and ${s.low} running low across live listings.</p>` +
      (s.stores.length ? `<ul class="dash-alerts">${s.stores.map((x) => `<li class="dash-alert is-${x.out ? 'danger' : 'warning'}"><span class="dash-alert-tag">${x.out ? 'Out' : 'Low'}</span> ${escapeHtml(x.storeName)}: ${x.out} out, ${x.low} low</li>`).join('')}</ul>
        <p><a href="#inv-admin-heading">Open the inventory overview →</a></p>` : '');
  }

  function exportTop() {
    if (!last) return;
    DashUI.downloadCsv(`mwakete-top-stores-${last.today}-${last.period}d.csv`, ['Store', 'Store type', 'Orders', 'Confirmed sales'],
      last.topStores.map((s) => [s.storeName, s.storeType, s.orders, Number(s.sales).toFixed(2)]));
  }

  function init() {
    if (!$('overview')) return;
    $('ov-period').addEventListener('change', (e) => load(Number(e.target.value)));
    $('ov-export').addEventListener('click', exportTop);
    load(7);
  }

  return { init };
})();
