// Admin: Contacts & SMS (backend SmsDevices.gs). Counts and flags per store;
// suspending a store stops its phones at the next check-in. A store's contacts
// are shown only after a written reason, which the server records in the audit
// log. Every call is checked again on the server (admin session, reason length).
const SmsAdmin = (() => {
  const $ = (id) => document.getElementById(id);
  const call = (action, body) => Api.post(action, Object.assign({ token: Auth.getToken() }, body || {}));
  const LIMITS = [
    ['maxContactsPerStore', 'Contacts per store'], ['maxCampaignRecipients', 'People per campaign'], ['maxDailyPerDevice', 'SMS per phone per day'],
    ['maxDailyPerStore', 'SMS per store per day'], ['minIntervalSeconds', 'Shortest gap (seconds)'], ['defaultIntervalSeconds', 'Default gap (seconds)'],
    ['maxDevicesPerStore', 'Phones per store'], ['quietStart', 'Quiet from (hour)'], ['quietEnd', 'Quiet until (hour)'], ['utcOffset', 'Time zone (UTC+)']
  ];
  let stores = [];

  async function load() {
    const res = await call('adminSmsOverview');
    const tbody = $('asm-stores').tBodies[0];
    if (!res.ok) { $('asm-status').textContent = res.error || 'Could not load.'; tbody.innerHTML = ''; return; }
    $('asm-status').textContent = '';
    stores = res.stores.sort((a, b) => b.sent - a.sent);
    tbody.innerHTML = stores.length ? stores.map((s) => `<tr data-owner="${escapeAttr(s.ownerId)}">
      <td>${escapeHtml(s.storeName)}${s.suspended ? ' <span class="sx-pill is-cancelled">Suspended</span>' : ''}</td>
      <td class="sx-num">${s.contacts}</td><td class="sx-num">${s.campaigns}</td><td class="sx-num">${s.sent}</td><td class="sx-num">${s.failed}</td>
      <td class="sx-num">${s.optOuts}</td><td class="sx-num">${s.devices}</td>
      <td>${s.flags.map((f) => `<span class="sx-pill is-check">${escapeHtml(f)}</span>`).join(' ')}</td>
      <td><button type="button" class="btn btn-small btn-light-purple" data-act="suspend">${s.suspended ? 'Allow sending' : 'Suspend'}</button>
        <button type="button" class="btn btn-small btn-light-purple" data-act="contacts">View contacts</button></td></tr>`).join('')
      : '<tr><td colspan="9" class="sx-empty">No store uses Contacts &amp; SMS yet.</td></tr>';
    LIMITS.forEach((l) => { if (!$('asm-l-' + l[0])) $('asm-limits').insertAdjacentHTML('beforeend', `<div class="field"><label for="asm-l-${l[0]}">${l[1]}</label><input type="number" id="asm-l-${l[0]}" data-limit="${l[0]}"></div>`); });
    LIMITS.forEach((l) => { $('asm-l-' + l[0]).value = res.limits[l[0]]; });
  }

  function askReason(what) {
    const r = prompt(`Why do you need to ${what}? This is saved in the audit log (at least 10 characters).`);
    if (r === null) return null;
    if (r.trim().length < 10) { alert('Please write a longer reason.'); return null; }
    return r.trim();
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = stores.find((x) => x.ownerId === b.closest('tr').dataset.owner);
    if (!s) return;
    if (b.dataset.act === 'suspend') {
      const reason = askReason(s.suspended ? `allow ${s.storeName} to send again` : `stop all sending by ${s.storeName}`);
      if (!reason) return;
      const r = await call('adminSmsSuspend', { ownerId: s.ownerId, suspend: !s.suspended, reason });
      if (!r.ok) alert(r.error || 'Could not change.');
      load();
      return;
    }
    const reason = askReason(`see the contacts of ${s.storeName}`);
    if (!reason) return;
    const r = await call('adminSmsViewContacts', { ownerId: s.ownerId, reason, limit: 200 });
    const box = $('asm-contacts');
    box.hidden = false;
    if (!r.ok) { box.innerHTML = `<p class="form-error">${escapeHtml(r.error || 'Could not load.')}</p>`; return; }
    box.innerHTML = `<h3>${escapeHtml(s.storeName)}: ${r.total} contacts${r.total > r.contacts.length ? ' (first ' + r.contacts.length + ')' : ''}</h3>
      <p class="helper-text">Viewing was recorded with your reason.</p>
      <div class="sx-table-wrap sx-scroll"><table class="sx-table"><thead><tr><th scope="col">Name</th><th scope="col">Number</th><th scope="col">Promotions</th><th scope="col">Source</th></tr></thead><tbody>${
        r.contacts.map((c) => `<tr><td>${escapeHtml([c.firstName, c.lastName].filter(Boolean).join(' ') || c.businessName)}</td><td>${escapeHtml(c.phone || c.phoneRaw)}</td><td>${escapeHtml(c.consent.promotional)}${c.consentSource ? ' · ' + escapeHtml(c.consentSource) : ''}</td><td>${escapeHtml(c.source)}</td></tr>`).join('')}</tbody></table></div>
      <p><button type="button" class="btn btn-small btn-light-purple" id="asm-contacts-close">Hide</button></p>`;
    $('asm-contacts-close').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
  }

  async function saveLimits() {
    const limits = {};
    document.querySelectorAll('#asm-limits [data-limit]').forEach((i) => { if (i.value !== '') limits[i.dataset.limit] = Number(i.value); });
    const r = await call('adminSmsLimits', { limits });
    $('asm-limits-msg').textContent = r.ok ? 'Saved (values outside the safe range were brought back into it).' : (r.error || 'Could not save.');
    if (r.ok) load();
  }

  function init() {
    if (!$('sms')) return;
    $('asm-stores').addEventListener('click', onClick);
    $('asm-limits-save').addEventListener('click', saveLimits);
    $('asm-limits').addEventListener('submit', (e) => e.preventDefault());
    load();
  }

  return { init };
})();
