document.addEventListener('DOMContentLoaded', init);

// Products/Orders/Bookings/Messages quick links: plain navigations to other
// owner pages. Deliberately NO loading animation - these are page loads with
// nothing real to wait on, and the old fake spinner had no stop condition:
// it set btn.disabled + an infinite dots animation and never cleared it, so a
// bfcache Back restored the frozen, still-"loading" button (the reported
// "spinner never stops" bug). Navigate straight away instead.
function wireQuickLinks() {
  document.querySelectorAll('.dashboard-quick-links .btn').forEach((btn) => {
    const href = btn.dataset.href;
    if (!href) return;
    btn.addEventListener('click', () => {
      window.location.href = href;
    });
  });
}

// Safety net for bfcache restores (Back button): if a quick-link button was
// ever left disabled, re-enable it so it can't come back stuck.
window.addEventListener('pageshow', () => {
  document.querySelectorAll('.dashboard-quick-links .btn[disabled]').forEach((btn) => {
    btn.disabled = false;
  });
});

const STORE_TYPE_LABEL = { wholesaler: 'Wholesaler', distributor: 'Distributor', retailer: 'Retailer' };

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  Auth.showWholesalePendingNotice(owner);

  document.getElementById('store-name-label').textContent = shortStoreName(owner.storeName);
  document.getElementById('welcome-name').textContent = `, ${owner.storeName}`;
  document.getElementById('dash-greeting').textContent = greeting();
  document.getElementById('storefront-link').href = `../store.html?store=${encodeURIComponent(owner.storeSlug)}`;

  wireQuickLinks();

  renderStoreToggle(owner.status);
  document.getElementById('store-status-toggle').addEventListener('click', onToggleStoreStatus);

  if (owner.isAdmin) {
    document.getElementById('admin-link-wrap').classList.remove('hidden');
  }

  document.getElementById('dash-period').addEventListener('change', (e) => loadSummary(Number(e.target.value)));
  await loadSummary(7);
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * One request for the whole page (Dashboards.gs getSellerDashboard), computed
 * on the server from ALL of this store's orders and stock - the old page asked
 * for three lists and counted only the first 100 orders. The Messages badge
 * still comes from owner-nav.js (getUnreadCount).
 */
async function loadSummary(days) {
  const statusEl = document.getElementById('dash-status');
  const stopLoading = startLoadingMessage(statusEl);
  const res = await Api.post('getSellerDashboard', { token: Auth.getToken(), days });
  stopLoading();
  if (!res.ok) {
    statusEl.innerHTML = 'Your store summary could not be loaded. <button type="button" class="btn btn-small" id="dash-retry">Try again</button>';
    document.getElementById('dash-retry').addEventListener('click', () => loadSummary(days));
    document.getElementById('recent-orders').innerHTML = '';
    document.getElementById('dash-alerts').innerHTML = '';
    return;
  }
  statusEl.textContent = '';
  renderKpis(res.kpis, res.period);
  renderChart(res.series);
  renderRecent(res.recentOrders);
  renderAlerts(res);
  renderWholesale(res.storeType, res.wholesale);
}

function change(now, before, money) {
  if (!before && !now) return 'Nothing yesterday either';
  if (!before) return 'None yesterday';
  const diff = now - before;
  const pct = Math.round((diff / before) * 100);
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  return `${arrow} ${Math.abs(pct)}% vs yesterday (${money ? formatMoney(before) : before})`.trim();
}

function renderKpis(k, period) {
  document.getElementById('kpi-orders-today').textContent = k.ordersToday;
  document.getElementById('kpi-orders-sub').textContent = change(k.ordersToday, k.ordersYesterday, false);
  document.getElementById('kpi-sales-today').textContent = formatMoney(k.salesToday);
  document.getElementById('kpi-sales-sub').textContent = change(k.salesToday, k.salesYesterday, true);
  document.getElementById('kpi-low-stock').textContent = k.lowStock + k.outOfStock;
  const stockSub = document.getElementById('kpi-stock-sub');
  stockSub.textContent = k.outOfStock ? `${k.outOfStock} out of stock - action needed` : k.lowStock ? 'Running low - reorder soon' : 'Stock looks healthy';
  stockSub.classList.toggle('is-warning', k.lowStock + k.outOfStock > 0);
  document.getElementById('kpi-needs-action').textContent = k.needsAction;
  const actionSub = document.getElementById('kpi-action-sub');
  actionSub.textContent = [k.pendingPayment ? `${k.pendingPayment} awaiting payment` : '', k.openProblems ? `${k.openProblems} problem report(s)` : '']
    .filter(Boolean).join(' · ') || 'All caught up';
  actionSub.classList.toggle('is-warning', k.needsAction > 0);

  setNavBadge('nav-orders-badge', k.pendingPayment + k.openProblems);
  setNavBadge('nav-bookings-badge', k.bookingsPending);
  document.getElementById('sales-total').textContent = `${formatMoney(k.periodSales)} confirmed from ${k.periodOrders} order(s) in the last ${period} days. Orders count as sales once you confirm payment.`;
}

/** A small inline SVG line chart - no chart library, a few hundred bytes. */
function renderChart(series) {
  const el = document.getElementById('sales-chart');
  const tbody = document.querySelector('#sales-table tbody');
  const label = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  tbody.innerHTML = series.map((s) => `<tr><td>${escapeHtml(label(s.day))}</td><td>${formatMoney(s.sales)}</td><td>${s.orders}</td></tr>`).join('');
  const max = Math.max(...series.map((s) => s.sales), 0);
  if (!max) {
    el.innerHTML = '<p class="dash-empty">No confirmed sales in this period yet.</p>';
    return;
  }
  const W = 600, H = 200, padL = 48, padB = 26, padT = 10;
  const step = (W - padL - 10) / Math.max(1, series.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const pts = series.map((s, i) => [padL + i * step, y(s.sales)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${H - padB} L${padL} ${H - padB} Z`;
  const every = series.length > 10 ? 5 : 1;
  const ticks = [0, 0.5, 1].map((f) => `<text x="${padL - 6}" y="${y(max * f) + 4}" text-anchor="end">${formatMoney(max * f).replace('.00', '')}</text>
    <line x1="${padL}" x2="${W - 10}" y1="${y(max * f)}" y2="${y(max * f)}" class="grid"/>`).join('');
  const xs = series.map((s, i) => (i % every === 0 || i === series.length - 1 ? `<text x="${pts[i][0]}" y="${H - 6}" text-anchor="middle">${escapeHtml(label(s.day))}</text>` : '')).join('');
  const dots = series.length <= 10 ? pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5"/>`).join('') : '';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${ticks}<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}${xs}</svg>`;
}

function statusPillHtml(status) {
  const cls = 'status-badge status-' + String(status || '').toLowerCase().replace(/\s+/g, '-');
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function renderRecent(list) {
  const el = document.getElementById('recent-orders');
  if (!list.length) { el.innerHTML = '<p class="dash-empty">No orders yet. When a customer orders, it appears here.</p>'; return; }
  const link = (o) => (o.room ? `../order-room.html?order=${encodeURIComponent(o.orderId)}&as=seller` : 'orders.html');
  el.innerHTML = `<table class="dash-table">
    <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Total</th><th scope="col">Status</th></tr></thead>
    <tbody>${list.map((o) => `<tr>
      <td data-label="Order"><a href="${link(o)}">${escapeHtml(o.orderId)}</a><span class="dash-table-sub">${escapeHtml(new Date(o.createdAt).toLocaleDateString())}</span></td>
      <td data-label="Customer">${escapeHtml(o.customerName)}<span class="dash-table-sub">${escapeHtml(o.itemsSummary || '')}</span></td>
      <td data-label="Total">${formatMoney(o.total)}</td>
      <td data-label="Status">${statusPillHtml(o.status)}${o.problem ? ' <span class="status-badge status-problem">Problem reported</span>' : ''}${o.stage && !o.problem ? `<span class="dash-table-sub">${escapeHtml(o.stage)}</span>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

function renderAlerts(res) {
  const k = res.kpis;
  const items = [];
  (res.problems || []).forEach((p) => items.push(['danger', `Problem reported on order ${p.orderId}: ${p.category}`, `../order-room.html?order=${encodeURIComponent(p.orderId)}&as=seller`]));
  (res.lowStock || []).forEach((s) => items.push([s.health === 'out' ? 'danger' : 'warning',
    `${s.health === 'out' ? 'Out of stock' : 'Low stock'}: ${s.name}${s.label ? ' - ' + s.label : ''} (${s.available} left)`, 'inventory.html']));
  if (k.pendingPayment) items.push(['info', `${k.pendingPayment} order(s) waiting for you to confirm payment`, 'orders.html']);
  if (k.bookingsPending) items.push(['info', `${k.bookingsPending} booking request(s) to answer`, 'bookings.html']);
  if (k.reviewWaiting) items.push(['warning', `${k.reviewWaiting} listing(s) need your changes before they can show`, 'products.html']);
  if (k.heldProducts) items.push(['info', `${k.heldProducts} listing(s) are being checked by Mwakete`, 'products.html']);
  if (k.roomUnread) items.push(['info', `${k.roomUnread} new message(s) or update(s) in your order rooms`, 'orders.html']);
  const tone = { danger: 'Urgent', warning: 'Attention', info: 'To do' };
  document.getElementById('dash-alerts').innerHTML = items.length
    ? items.map(([t, text, href]) => `<li class="dash-alert is-${t}"><span class="dash-alert-tag">${tone[t]}</span> <a href="${href}">${escapeHtml(text)}</a></li>`).join('')
    : '<li class="dash-empty">Nothing needs your attention right now.</li>';
}

function renderWholesale(type, w) {
  const typeEl = document.getElementById('dash-store-type');
  typeEl.hidden = false;
  typeEl.textContent = STORE_TYPE_LABEL[type] || 'Retailer';
  const box = document.getElementById('dash-wholesale');
  if (!w) { box.hidden = true; return; }
  box.hidden = false;
  document.getElementById('wholesale-heading').textContent = type === 'distributor' ? 'Distributor' : 'Wholesale';
  document.getElementById('dash-wholesale-facts').innerHTML = `
    <div><dt>Verification</dt><dd>${w.verified ? 'Verified by Mwakete' : 'Waiting for Mwakete’s verification call'}</dd></div>
    <div><dt>Units on hand</dt><dd>${w.unitsOnHand} (tracked stock)</dd></div>
    ${type === 'distributor' ? `<div><dt>Locations</dt><dd>${w.locations} - <a href="inventory.html">manage stock by location</a></dd></div>` : ''}`;
}

// Open/Closed store toggle. OPEN = 'active' (visible to customers),
// CLOSED = 'standby' (hidden from customers, but the seller stays logged in
// and keeps full access - deliberately NOT 'closed', which locks the account
// out; that hard delete lives in Settings). Reuses the existing setStoreStatus
// endpoint - no backend change. Anything other than standby/closed is treated
// as open, so an older session profile without a status still reads correctly.
function renderStoreToggle(status) {
  const toggle = document.getElementById('store-status-toggle');
  if (!toggle) return;
  const open = status !== 'standby' && status !== 'closed';
  toggle.setAttribute('aria-checked', open ? 'true' : 'false');
  toggle.classList.toggle('is-open', open);
  document.getElementById('store-status-open-label').classList.toggle('active', open);
  document.getElementById('store-status-closed-label').classList.toggle('active', !open);
  document.getElementById('store-status-toggle-hint').textContent = open
    ? 'Your store is OPEN — visible to customers.'
    : 'Your store is CLOSED — hidden from customers. You stay logged in.';
}

async function onToggleStoreStatus() {
  const toggle = document.getElementById('store-status-toggle');
  const hint = document.getElementById('store-status-toggle-hint');
  const owner = Auth.getOwner();
  const next = owner.status === 'standby' ? 'active' : 'standby';

  toggle.disabled = true;
  const res = await Api.post('setStoreStatus', { token: Auth.getToken(), status: next });
  toggle.disabled = false;

  if (!res.ok) {
    hint.textContent = res.error || 'Could not update store status. Please try again.';
    return;
  }
  owner.status = next;
  Auth.saveSession(Auth.getToken(), owner);
  renderStoreToggle(next);
}

// Shows a red count in a quick-link button's corner when there's something
// needing attention; hides it at zero. Caps the display at 99+ so a big backlog
// never blows out the pill.
function setNavBadge(id, count) {
  const badge = document.getElementById(id);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}
