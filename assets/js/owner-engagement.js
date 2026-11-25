/**
 * Seller campaign management UI (CESN Stage 7). Compose / preview / save /
 * send / schedule / pause / cancel engagement notifications, and see the
 * analytics the backend can actually verify. Every send goes through the
 * backend's one gate (emitEngagementEvent), so this page cannot reach anyone
 * outside the eligible, consented audience.
 */
document.addEventListener('DOMContentLoaded', init);

let ecCategories = [];

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('ec-preview').addEventListener('click', onPreview);
  document.getElementById('ec-save').addEventListener('click', () => saveDraft().then((id) => { if (id) setStatus('Saved as a draft.'); loadCampaigns(); }));
  document.getElementById('ec-send').addEventListener('click', onSendNow);
  document.getElementById('ec-schedule-btn').addEventListener('click', onSchedule);
  document.getElementById('ec-category').addEventListener('change', () => { document.getElementById('ec-audience-hint').textContent = ''; });
  document.getElementById('ec-list').addEventListener('click', onListClick);
  loadCampaigns();
}

function tok() { return Auth.getToken(); }
function setStatus(msg) { document.getElementById('ec-form-status').textContent = msg || ''; }
function fieldVals() {
  return {
    campaignId: document.getElementById('ec-id').value || '',
    category: document.getElementById('ec-category').value,
    title: document.getElementById('ec-title').value.trim(),
    body: document.getElementById('ec-body').value.trim(),
    deepLink: document.getElementById('ec-link').value.trim()
  };
}

async function loadCampaigns() {
  let res;
  try { res = await Api.post('listEngagementCampaigns', { token: tok() }); } catch (e) { res = null; }
  if (!res || !res.ok) { document.getElementById('ec-list-status').textContent = 'Could not load your notifications.'; return; }
  if (!ecCategories.length && res.manualCategories) {
    ecCategories = res.manualCategories;
    const sel = document.getElementById('ec-category');
    sel.innerHTML = ecCategories.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('');
  }
  renderCampaigns(res.campaigns || []);
}

function renderCampaigns(list) {
  const ul = document.getElementById('ec-list');
  const status = document.getElementById('ec-list-status');
  if (!list.length) { ul.innerHTML = ''; status.textContent = 'No notifications yet. Compose one above.'; return; }
  status.textContent = '';
  const labelOf = (k) => (ecCategories.find((c) => c.key === k) || {}).label || k;
  ul.innerHTML = list.map((c) => {
    const a = c.analytics || {};
    const stats = (c.status === 'sent')
      ? `<span class="ec-stat">${a.inAppDelivered} delivered</span><span class="ec-stat">${a.opened} opened</span>` +
        (a.skippedFrequency || a.skippedDuplicate ? `<span class="ec-stat ec-stat--muted">${a.skippedFrequency + a.skippedDuplicate} skipped</span>` : '')
      : '';
    const actions = [];
    if (c.status === 'draft' || c.status === 'paused') actions.push(`<button type="button" class="btn btn-small ec-act" data-act="send" data-id="${escapeHtml(c.campaignId)}">Send now</button>`);
    if (c.status === 'scheduled') actions.push(`<button type="button" class="btn btn-small btn-outline ec-act" data-act="pause" data-id="${escapeHtml(c.campaignId)}">Pause</button>`);
    if (c.status !== 'sent' && c.status !== 'cancelled') actions.push(`<button type="button" class="btn btn-small btn-outline ec-act" data-act="cancel" data-id="${escapeHtml(c.campaignId)}">Cancel</button>`);
    const when = c.status === 'scheduled' && c.scheduleAt ? ` · for ${escapeHtml(new Date(c.scheduleAt).toLocaleString())}` : '';
    return `<li class="ec-item ec-item--${escapeHtml(c.status)}">
      <div class="ec-item-head"><span class="ec-badge">${escapeHtml(labelOf(c.category))}</span><span class="ec-status">${escapeHtml(c.status)}${when}</span></div>
      <strong class="ec-title">${escapeHtml(c.title)}</strong>
      <p class="ec-body">${escapeHtml(c.body)}</p>
      <div class="ec-stats">${stats}</div>
      <div class="ec-item-actions">${actions.join('')}</div>
    </li>`;
  }).join('');
}

async function onPreview() {
  const v = fieldVals();
  const hint = document.getElementById('ec-audience-hint');
  if (!v.title || !v.body) { hint.textContent = 'Add a title and message first.'; return; }
  let res;
  try { res = await Api.post('previewEngagementCampaign', { token: tok(), category: v.category, title: v.title, body: v.body }); } catch (e) { res = null; }
  if (res && res.ok) hint.textContent = res.eligibleAudience === 1 ? 'This would reach 1 eligible shopper.' : `This would reach ${res.eligibleAudience} eligible shoppers.`;
  else hint.textContent = 'Could not check the audience.';
}

// Create (or update) the draft; returns the campaign id, or '' on failure.
async function saveDraft() {
  const v = fieldVals();
  if (!v.title || !v.body) { setStatus('A title and message are required.'); return ''; }
  let res;
  try {
    res = v.campaignId
      ? await Api.post('updateEngagementCampaign', { token: tok(), campaignId: v.campaignId, category: v.category, title: v.title, body: v.body, deepLink: v.deepLink })
      : await Api.post('createEngagementCampaign', { token: tok(), category: v.category, title: v.title, body: v.body, deepLink: v.deepLink });
  } catch (e) { res = null; }
  if (!res || !res.ok) { setStatus((res && res.error) || 'Could not save.'); return ''; }
  const id = v.campaignId || res.campaignId;
  document.getElementById('ec-id').value = id;
  return id;
}

async function onSendNow() {
  const v = fieldVals();
  if (!v.title || !v.body) { setStatus('A title and message are required.'); return; }
  if (!confirm('Send this notification now to all eligible shoppers?')) return;
  setStatus('Sending…');
  const id = await saveDraft();
  if (!id) return;
  let res;
  try { res = await Api.post('sendEngagementCampaign', { token: tok(), campaignId: id }); } catch (e) { res = null; }
  if (res && res.ok) {
    setStatus(`Sent to ${res.queued} shopper${res.queued === 1 ? '' : 's'}.` + (res.skippedFrequency ? ` ${res.skippedFrequency} were at their notification limit.` : ''));
    resetForm();
  } else setStatus((res && res.error) || 'Could not send.');
  loadCampaigns();
}

async function onSchedule() {
  const at = document.getElementById('ec-schedule-at').value;
  if (!at) { setStatus('Pick a date and time to schedule.'); return; }
  const id = await saveDraft();
  if (!id) return;
  let res;
  try { res = await Api.post('setEngagementCampaignStatus', { token: tok(), campaignId: id, status: 'scheduled', scheduleAt: new Date(at).toISOString() }); } catch (e) { res = null; }
  if (res && res.ok) { setStatus('Scheduled.'); resetForm(); } else setStatus((res && res.error) || 'Could not schedule.');
  loadCampaigns();
}

async function onListClick(e) {
  const btn = e.target.closest('.ec-act');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'send' && !confirm('Send this notification now?')) return;
  if (act === 'cancel' && !confirm('Cancel this notification?')) return;
  btn.disabled = true;
  let res;
  try {
    res = (act === 'send')
      ? await Api.post('sendEngagementCampaign', { token: tok(), campaignId: id })
      : await Api.post('setEngagementCampaignStatus', { token: tok(), campaignId: id, status: act === 'pause' ? 'paused' : 'cancelled' });
  } catch (err) { res = null; }
  if (!res || !res.ok) btn.disabled = false;
  loadCampaigns();
}

function resetForm() {
  document.getElementById('ec-id').value = '';
  document.getElementById('ec-title').value = '';
  document.getElementById('ec-body').value = '';
  document.getElementById('ec-link').value = '';
  document.getElementById('ec-schedule-at').value = '';
  document.getElementById('ec-audience-hint').textContent = '';
}
