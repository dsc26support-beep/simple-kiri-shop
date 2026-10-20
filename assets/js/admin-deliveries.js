// Admin: drivers and delivery jobs (backend Deliveries.gs, isOwnerAdmin on
// the server). Approve / reject / suspend drivers, watch active jobs, and
// see failed or stuck deliveries. Each job links to its order room.
const DeliveriesAdmin = (() => {
  const $ = (id) => document.getElementById(id);

  async function load() {
    $('dlv-status').textContent = 'Loading…';
    const res = await Api.post('adminListDeliveries', { token: Auth.getToken(), status: $('dlv-filter').value });
    if (!res.ok || !res.counts) { $('dlv-status').textContent = (res && res.error) || 'Could not load deliveries.'; return; }
    $('dlv-status').textContent = '';
    $('dlv-mode').textContent = res.enabled ? (res.allIslands ? 'Mwakete drivers are ON on every island. A job is only for a store and buyer on the same island, and only drivers there see it.' : `Mwakete drivers are ON for: ${res.areas.join(', ')} (within one island only).`) : 'Mwakete drivers are OFF (Script Property DELIVERY_JOBS). Nothing here is visible to sellers or drivers yet.';
    const c = res.counts;
    const card = (label, v, sub) => `<div class="kpi-card"><span class="kpi-label">${escapeHtml(label)}</span><strong class="kpi-value">${v}</strong>${sub ? `<span class="kpi-sub${/stuck|fail/i.test(sub) && v ? ' is-warning' : ''}">${escapeHtml(sub)}</span>` : ''}</div>`;
    $('dlv-counts').innerHTML = card('Waiting for a driver', c.open, '') + card('On the way', c.active, '') +
      card('Failed / stuck', c.failed + c.stuck, `${c.failed} failed · ${c.stuck} stuck`) + card('Drivers online', c.driversOnline, `${c.driversPending} waiting for approval`);
    $('dlv-drivers').innerHTML = res.drivers.length ? `<table class="dash-table"><thead><tr><th scope="col">Driver</th><th scope="col">Vehicle / area</th><th scope="col">Record</th><th scope="col">Status</th></tr></thead><tbody>${res.drivers.map((d) => `<tr>
      <td data-label="Driver">${escapeHtml(d.name)}<span class="dash-table-sub"><a href="tel:${escapeHtml(d.phone)}">${escapeHtml(d.phone)}</a> · ${escapeHtml(d.email)}</span></td>
      <td data-label="Vehicle / area">${escapeHtml(d.vehicle)}<span class="dash-table-sub">${escapeHtml(d.area)}</span></td>
      <td data-label="Record">${d.delivered} delivered · ${d.failed} failed</td>
      <td data-label="Status"><strong>${escapeHtml(d.status)}</strong>${d.online ? ' · online' : ''}${d.note ? `<span class="dash-table-sub">${escapeHtml(d.note)}</span>` : ''}
        <span class="dlv-actions">${d.status !== 'approved' ? `<button type="button" class="btn btn-small" data-driver="${escapeHtml(d.driverId)}" data-set="approved">Approve</button>` : ''}
        ${d.status === 'pending' ? `<button type="button" class="btn btn-small" data-driver="${escapeHtml(d.driverId)}" data-set="rejected">Reject</button>` : ''}
        ${d.status === 'approved' ? `<button type="button" class="btn btn-small" data-driver="${escapeHtml(d.driverId)}" data-set="suspended">Suspend</button>` : ''}</span></td></tr>`).join('')}</tbody></table>`
      : '<p class="dash-empty">No driver applications yet.</p>';
    $('dlv-jobs').innerHTML = res.jobs.length ? `<table class="dash-table"><thead><tr><th scope="col">Order</th><th scope="col">Driver</th><th scope="col">Fee</th><th scope="col">Status</th></tr></thead><tbody>${res.jobs.map((j) => `<tr>
      <td data-label="Order"><a href="../order-room.html?order=${encodeURIComponent(j.orderId)}&amp;as=admin">${escapeHtml(j.orderId)}</a><span class="dash-table-sub">${escapeHtml(j.storeName)} → ${escapeHtml(j.dropoff)}</span></td>
      <td data-label="Driver">${j.driverName ? `${escapeHtml(j.driverName)}<span class="dash-table-sub"><a href="tel:${escapeHtml(j.driverPhone)}">${escapeHtml(j.driverPhone)}</a></span>` : '—'}
        ${j.location ? `<span class="dash-table-sub"><a href="${escapeHtml(j.location.link)}" target="_blank" rel="noopener">Live location</a></span>` : ''}</td>
      <td data-label="Fee">${formatMoney(j.fee)}<span class="dash-table-sub">${j.feePaid ? 'Paid' : 'Not marked paid'}</span></td>
      <td data-label="Status">${escapeHtml(j.statusLabel)}${j.stuck ? ' <span class="status-badge status-problem">Stuck</span>' : ''}${j.failReason ? `<span class="dash-table-sub">${escapeHtml(j.failReason)}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="dash-empty">No delivery jobs here.</p>';
  }

  async function onClick(e) {
    const b = e.target.closest('[data-driver]');
    if (!b) return;
    const status = b.dataset.set;
    let reason = '';
    if (status !== 'approved') {
      reason = prompt(`Reason to ${status === 'rejected' ? 'reject' : 'suspend'} this driver (they will see it):`) || '';
      if (!reason) return;
    } else if (!confirm('Approve this driver? Only approve someone you have spoken to.')) return;
    b.disabled = true;
    const res = await Api.post('adminSetDriverStatus', { token: Auth.getToken(), driverId: b.dataset.driver, status, reason });
    if (!res.ok) { alert(res.error || 'Not saved.'); b.disabled = false; return; }
    await load();
  }

  function init() {
    if (!$('deliveries')) return;
    $('dlv-filter').addEventListener('change', load);
    $('dlv-drivers').addEventListener('click', onClick);
    load();
  }

  return { init };
})();
