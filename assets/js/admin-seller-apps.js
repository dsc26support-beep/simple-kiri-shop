// Admin: Become a Seller applications (backend SellerApplications.gs).
// Approve / not approve / suspend / reinstate - each checked again on the
// server (admin email) and logged there. Nothing here is trusted by it.
const SellerAppsAdmin = (() => {
  const $ = (id) => document.getElementById(id);
  let status = 'pending';
  let apps = [];
  const ACTIONS = {
    pending: [['approve', 'Approve'], ['reject', 'Not approve']],
    rejected: [['approve', 'Approve after all']],
    approved: [['suspend', 'Suspend']],
    suspended: [['reinstate', 'Reinstate']]
  };

  async function load() {
    $('sa-status').innerHTML = loadingMessageHtml();
    $('sa-list').textContent = '';
    const res = await Api.post('adminListSellerApplications', { token: Auth.getToken(), status });
    if (!res.ok) { $('sa-status').textContent = res.error || 'Could not load the applications.'; return; }
    apps = res.applications || [];
    $('sa-status').textContent = apps.length ? apps.length + ' shown.' : 'Nothing here.';
    $('sa-list').innerHTML = apps.map((a) => `<article class="sa-item" data-id="${escapeHtml(a.ownerId)}">
      <h3>${escapeHtml(a.storeName)} <span class="helper-text">(${escapeHtml(a.storeType)})</span></h3>
      <p class="helper-text">Applied ${escapeHtml(String(a.appliedAt || '').slice(0, 10) || '-')} · ${escapeHtml(a.email)} · ${escapeHtml(a.phone)}${a.messenger ? ' · <a href="' + escapeHtml(a.messenger) + '" target="_blank" rel="noopener noreferrer">Messenger</a>' : ''}</p>
      <p>${escapeHtml(a.about || '(no description)')}</p>
      ${a.reviewNote ? `<p class="helper-text">Note: ${escapeHtml(a.reviewNote)}</p>` : ''}
      <div class="field"><label for="sa-note-${escapeHtml(a.ownerId)}">Reason or note (sent to the seller)</label>
        <input id="sa-note-${escapeHtml(a.ownerId)}" class="sa-note" maxlength="500" autocomplete="off"></div>
      <div class="sa-actions">${(ACTIONS[a.status] || []).map(([d, label]) =>
        `<button type="button" class="btn btn-small${d === 'approve' || d === 'reinstate' ? ' btn-light-purple' : ''}" data-decision="${d}">${label}</button>`).join(' ')}</div>
      <p class="form-error" role="alert"></p>
    </article>`).join('');
  }

  async function decide(e) {
    const btn = e.target.closest('button[data-decision]');
    if (!btn) return;
    const item = btn.closest('.sa-item');
    const decision = btn.dataset.decision;
    const note = item.querySelector('.sa-note').value.trim();
    const errorEl = item.querySelector('.form-error');
    errorEl.textContent = '';
    if ((decision === 'reject' || decision === 'suspend') && !note) {
      errorEl.textContent = 'Write a short reason - the seller sees it in the email.';
      item.querySelector('.sa-note').focus();
      return;
    }
    if (decision === 'suspend' && !window.confirm('Suspend this store? It is hidden from shoppers and signed out at once.')) return;
    const busyDone = setButtonBusy(btn, 'Saving');
    const res = await Api.post('adminReviewSellerApplication', { token: Auth.getToken(), ownerId: item.dataset.id, decision, note });
    busyDone();
    if (!res.ok) { errorEl.textContent = res.error || 'Could not save that.'; return; }
    item.remove();
    $('sa-status').textContent = '"' + res.application.storeName + '" is now ' + res.application.status + '. The seller has been emailed.';
  }

  function pick(e) {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    status = btn.dataset.status;
    $('sa-filters').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
    load();
  }

  function init() {
    if (!$('seller-applications')) return;
    $('sa-filters').addEventListener('click', pick);
    $('sa-list').addEventListener('click', decide);
    load();
  }

  return { init };
})();
