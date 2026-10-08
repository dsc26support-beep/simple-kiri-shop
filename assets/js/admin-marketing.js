/**
 * Admin page: Marketing (owner/admin.html only - no public page loads this).
 *
 * Everything here is a view onto Marketing.gs; every action is re-checked
 * server-side with isOwnerAdmin, so hiding a button is never the protection.
 * No response this page receives carries a customer's email address.
 */
const MKT_TYPE_LABEL = {
  PRODUCT_INTEREST: 'Still interested', STORE_UPDATE: 'New at a store', CATEGORY_TRENDING: 'Popular',
  NEW_PRODUCTS: 'New on Mwakete', INACTIVE_CUSTOMER: 'Lapsed customers', RETURNING_CUSTOMER: 'Returning customers',
  SELLER_PROMOTION: 'Seller promotion', SEASONAL: 'Seasonal'
};
const MKT_AUDIENCE_LABEL = {
  AUTOMATIC: 'Automatic', ALL_OPTED_IN: 'Everyone opted in', STORE_CUSTOMERS: 'Store customers', CATEGORY_INTEREST: 'Category'
};
// What an admin can do from each status (mirrors CAMPAIGN_TRANSITIONS in Marketing.gs).
const MKT_OPS = {
  DRAFT: [['approve', 'Approve'], ['cancel', 'Cancel']],
  READY: [['pause', 'Pause'], ['cancel', 'Cancel']],
  SCHEDULED: [['pause', 'Pause'], ['cancel', 'Cancel']],
  PROCESSING: [['pause', 'Pause'], ['cancel', 'Cancel']],
  PAUSED: [['resume', 'Resume'], ['cancel', 'Cancel']]
};

let mktPaused = false;

function initMarketingAdmin() {
  document.getElementById('mkt-pause-btn').addEventListener('click', onMktPauseToggle);
  document.getElementById('mkt-generate-btn').addEventListener('click', onMktGenerate);
  document.getElementById('mkt-campaigns').addEventListener('click', onMktCampaignClick);
  document.getElementById('mkt-form').addEventListener('submit', onMktCreate);
  document.getElementById('mkt-store').addEventListener('change', loadMktProducts);
  document.getElementById('mkt-audience').addEventListener('change', syncMktForm);
  document.getElementById('mkt-type').addEventListener('change', syncMktForm);
  fillMktFormChoices();
  loadMarketing();
}

const mktPost = (action, extra) => Api.post(action, Object.assign({ token: Auth.getToken() }, extra || {}));
const mktDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

async function loadMarketing() {
  const res = await mktPost('getMarketingOverview');
  // The website updates on merge; the backend only when Apps Script is
  // redeployed. Until then this answers without the overview - say so rather
  // than break the rest of the admin page.
  if (!res || !res.ok || !res.settings || !res.totals) {
    document.getElementById('mkt-status').textContent = (res && res.error && res.ok === false && !/Unknown action/i.test(res.error))
      ? res.error : 'Marketing needs the latest backend: redeploy Apps Script (see DEPLOY.md), then reload this page.';
    return;
  }
  renderMktStatus(res.settings);
  renderMktTotals(res.totals);
  renderMktCampaigns(res.campaigns || []);
  const stats = await mktPost('getMarketingStats');
  if (stats && stats.ok && Array.isArray(stats.stats)) renderMktStats(stats.stats);
}

function renderMktStatus(s) {
  mktPaused = s.paused;
  let mode;
  if (!s.enabled) mode = '<strong>Off.</strong> MARKETING_ENABLED is not set to true in Script Properties, so nothing runs.';
  else if (s.paused) mode = '<strong>Paused.</strong> Nothing is being sent.';
  else if (s.dryRun) mode = '<strong>Dry run.</strong> It records who would be emailed, but sends nothing.';
  else mode = '<strong>Live.</strong> Approved campaigns are being sent.';
  const parts = [
    mode,
    `Up to ${escapeHtml(s.dailyLimit)} promotional emails a day, ${escapeHtml(s.batchSize)} per hourly run, and at most ${escapeHtml(s.maxPerWindow)} per customer every ${escapeHtml(s.frequencyDays)} days.`,
    s.autoApprove ? 'Automatic campaigns send without approval.' : 'Automatic campaigns wait for your approval.'
  ];
  if (!s.siteBaseSet) parts.push('<strong>SITE_BASE_URL is not set</strong> - emails need it for their links, so nothing will send.');
  document.getElementById('mkt-status').innerHTML = '<p>' + parts.join(' ') + '</p>';
  const btn = document.getElementById('mkt-pause-btn');
  btn.hidden = !s.enabled;
  btn.textContent = s.paused ? 'Resume all marketing' : 'Pause all marketing';
}

function renderMktTotals(t) {
  const stat = (v, l) => `<div class="admin-stat"><span class="admin-stat-value">${escapeHtml(v)}</span><span class="admin-stat-label">${escapeHtml(l)}</span></div>`;
  document.getElementById('mkt-totals').innerHTML = [
    stat(t.optedIn, 'Customers opted in'), stat(t.campaigns, 'Campaigns'), stat(t.drafts, 'Waiting approval'),
    stat(t.scheduled, 'Scheduled'), stat(t.sent, 'Finished'), stat(t.emailsSent, 'Emails sent'),
    stat(t.emailsFailed, 'Failed'), stat(t.dryRun, 'Dry run (not sent)')
  ].join('');
}

function renderMktCampaigns(list) {
  const body = document.querySelector('#mkt-campaigns tbody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7">No campaigns yet.</td></tr>';
    return;
  }
  body.innerHTML = list.map((c) => {
    const ops = (MKT_OPS[c.status] || []).map(([op, label]) =>
      // Approve/Resume is the one action you are here to take: filled purple.
      // Pause and Cancel are outlined, so they can't be hit by mistake for it.
      `<button type="button" class="btn btn-small ${op === 'approve' || op === 'resume' ? 'btn-primary' : 'btn-light-purple'}" data-mkt-op="${escapeAttr(op)}" data-id="${escapeAttr(c.campaignId)}">${escapeHtml(label)}</button>`).join(' ');
    return `<tr>
      <td>${escapeHtml(c.name)}<br><span class="helper-text">${escapeHtml(c.subject)}</span></td>
      <td>${escapeHtml(MKT_TYPE_LABEL[c.type] || c.type)}</td>
      <td><span class="mkt-badge mkt-badge--${escapeAttr(String(c.status).toLowerCase())}">${escapeHtml(c.status)}</span></td>
      <td>${escapeHtml(MKT_AUDIENCE_LABEL[c.audienceType] || c.audienceType)}</td>
      <td>${escapeHtml(mktDate(c.startAt))}<br><span class="helper-text">to ${escapeHtml(mktDate(c.endAt))}</span></td>
      <td>${escapeHtml(c.sentCount)}${c.failedCount ? ` <span class="helper-text">(${escapeHtml(c.failedCount)} failed)</span>` : ''}</td>
      <td class="mkt-ops"><button type="button" class="btn btn-small btn-light-purple" data-mkt-preview="${escapeAttr(c.campaignId)}">Preview</button> ${ops}</td>
    </tr>`;
  }).join('');
}

function renderMktStats(stats) {
  const body = document.querySelector('#mkt-stats tbody');
  const shown = stats.filter((s) => s.sent || s.failed || s.dryRun || s.skipped);
  body.innerHTML = shown.length ? shown.map((s) => `<tr>
    <td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.sent)}</td><td>${escapeHtml(s.failed)}${s.retrying ? ` <span class="helper-text">(+${escapeHtml(s.retrying)} retrying)</span>` : ''}</td>
    <td>${escapeHtml(s.skipped)}</td><td>${escapeHtml(s.dryRun)}</td><td>${escapeHtml(s.clicks)}</td><td>${escapeHtml(s.conversions)}</td></tr>`).join('')
    : '<tr><td colspan="7">Nothing sent yet.</td></tr>';
}

async function onMktCampaignClick(e) {
  const pv = e.target.closest('[data-mkt-preview]');
  if (pv) return showMktPreview(pv.dataset.mktPreview);
  const b = e.target.closest('[data-mkt-op]');
  if (!b) return;
  const op = b.dataset.mktOp;
  if (op === 'cancel' && !window.confirm('Cancel this campaign? It will not send to anyone else.')) return;
  b.disabled = true;
  const res = await mktPost('setMarketingCampaignStatus', { campaignId: b.dataset.id, op });
  document.getElementById('mkt-msg').textContent = res.ok ? 'Campaign is now ' + res.status.toLowerCase() + '.' : (res.error || 'Could not change it.');
  loadMarketing();
}

async function showMktPreview(id) {
  const box = document.getElementById('mkt-preview');
  box.hidden = false;
  box.textContent = 'Loading preview…';
  const res = await mktPost('previewMarketingCampaign', { campaignId: id });
  if (!res.ok) { box.textContent = res.error || 'Could not load the preview.'; return; }
  const reasons = Object.keys(res.reasons || {}).map((r) => `<li>${escapeHtml(res.reasons[r])} × ${escapeHtml(r)}</li>`).join('');
  box.innerHTML = `<div class="admin-analytics-head"><h3>${escapeHtml(res.campaign.name)}</h3>
      <button type="button" class="btn btn-small btn-light-purple" id="mkt-preview-close">Close</button></div>
    <p><strong>${escapeHtml(res.audienceSize)}</strong> would get it now${res.alreadyHandled ? `, ${escapeHtml(res.alreadyHandled)} already handled` : ''}. Estimated emails: ${escapeHtml(res.estimatedEmails)}.</p>
    ${reasons ? `<p>Why they qualify:</p><ul>${reasons}</ul>` : '<p>Nobody qualifies right now.</p>'}
    ${res.sample ? `<p><strong>Subject:</strong> ${escapeHtml(res.sample.subject)}</p><pre class="mkt-sample">${escapeHtml(res.sample.text)}</pre>` : ''}`;
  document.getElementById('mkt-preview-close').addEventListener('click', () => { box.hidden = true; });
  box.focus();
}

async function onMktPauseToggle() {
  const res = await mktPost('setMarketingPaused', { paused: !mktPaused });
  document.getElementById('mkt-msg').textContent = res.ok ? (res.paused ? 'All marketing paused.' : 'Marketing resumed.') : (res.error || 'Could not change it.');
  loadMarketing();
}

async function onMktGenerate() {
  const btn = document.getElementById('mkt-generate-btn');
  btn.disabled = true;
  const res = await mktPost('runMarketingGeneration');
  btn.disabled = false;
  document.getElementById('mkt-msg').textContent = !res.ok ? (res.error || 'Could not check.')
    : res.created.length ? res.created.length + ' new campaign(s) added for your approval.' : 'No new opportunities right now.';
  loadMarketing();
}

/* ---------- create form ---------- */

function fillMktFormChoices() {
  // Same store list the feature tools above use (loadStores in admin.js).
  const stores = document.getElementById('store-select');
  document.getElementById('mkt-store').innerHTML = stores ? stores.innerHTML : '<option value="">Choose a store…</option>';
  const cats = (typeof CATEGORIES !== 'undefined' ? CATEGORIES : []).filter((c) => c.active);
  document.getElementById('mkt-category').innerHTML = cats.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label)}</option>`).join('');
  syncMktForm();
}

function syncMktForm() {
  const aud = document.getElementById('mkt-audience').value;
  document.getElementById('mkt-category-field').hidden = aud !== 'CATEGORY_INTEREST';
}

async function loadMktProducts() {
  const slug = document.getElementById('mkt-store').value;
  const field = document.getElementById('mkt-products-field');
  const wrap = document.getElementById('mkt-products');
  if (!slug) { field.hidden = true; wrap.innerHTML = ''; return; }
  const res = await Api.get('listProducts', { storeSlug: slug });
  const products = res.ok ? (res.products || []) : [];
  field.hidden = !products.length;
  wrap.innerHTML = products.slice(0, 40).map((p) =>
    `<label class="sync-check"><input type="checkbox" name="mkt-product" value="${escapeAttr(p.productId)}"> ${escapeHtml(p.name)}</label>`).join('');
}

async function onMktCreate(e) {
  e.preventDefault();
  const err = document.getElementById('mkt-form-error');
  err.textContent = '';
  const val = (id) => document.getElementById(id).value;
  const productIds = Array.from(document.querySelectorAll('input[name="mkt-product"]:checked')).map((i) => i.value);
  if (productIds.length > 4) { err.textContent = 'Choose up to 4 products.'; return; }
  const toIso = (v) => (v ? new Date(v).toISOString() : '');
  const res = await mktPost('createMarketingCampaign', {
    name: val('mkt-name'), type: val('mkt-type'), audience: val('mkt-audience'), storeSlug: val('mkt-store'),
    productIds, category: val('mkt-category'), subject: val('mkt-subject'), message: val('mkt-message'),
    startAt: toIso(val('mkt-start')), endAt: toIso(val('mkt-end')), maxRecipients: val('mkt-max')
  });
  if (!res.ok) { err.textContent = res.error || 'Could not save it.'; return; }
  document.getElementById('mkt-form').reset();
  document.getElementById('mkt-products-field').hidden = true;
  document.getElementById('mkt-msg').textContent = 'Saved as a draft. Preview it, then Approve to schedule it.';
  loadMarketing();
}
