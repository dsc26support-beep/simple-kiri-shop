document.addEventListener('DOMContentLoaded', init);

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;

  if (!owner.isAdmin) {
    document.getElementById('admin-denied').classList.remove('hidden');
    return;
  }
  document.getElementById('admin-tools').classList.remove('hidden');

  await loadStores();
  document.getElementById('feature-store-btn').addEventListener('click', onFeatureStore);
  document.getElementById('prod-store-select').addEventListener('change', onPickStoreForProduct);
  document.getElementById('feature-product-btn').addEventListener('click', onFeatureProduct);
  document.getElementById('badge-recompute-btn').addEventListener('click', onRecomputeBadges);
  loadFeatured();
  loadSellerBadges();
  loadWholesalers();
  loadFeaturePayments();
  initAdminSearch();
  initAdminJump();
  loadInventoryOverview();
  if (typeof initMarketingAdmin === 'function') initMarketingAdmin();   // admin-marketing.js
  if (typeof ListingReviewAdmin !== 'undefined') ListingReviewAdmin.init();   // admin-listing-review.js
  if (typeof HeaderAdsAdmin !== 'undefined') HeaderAdsAdmin.init();   // admin-header-ads.js
}

async function loadStores() {
  const res = await Api.get('listStores', {});
  const stores = res.ok ? (res.stores || []) : [];
  const opts = ['<option value="">Choose a store…</option>']
    .concat(stores.map((s) => `<option value="${escapeHtml(s.storeSlug)}">${escapeHtml(s.storeName)}</option>`))
    .join('');
  document.getElementById('store-select').innerHTML = opts;
  document.getElementById('prod-store-select').innerHTML = opts;
}

async function onPickStoreForProduct() {
  const slug = document.getElementById('prod-store-select').value;
  const sel = document.getElementById('product-select');
  if (!slug) {
    sel.innerHTML = '<option value="">Choose a store first…</option>';
    return;
  }
  sel.innerHTML = '<option value="">Loading…</option>';
  const res = await Api.get('listProducts', { storeSlug: slug });
  const products = res.ok ? (res.products || []) : [];
  sel.innerHTML = ['<option value="">Choose a product…</option>']
    .concat(products.map((p) => `<option value="${escapeHtml(p.productId)}">${escapeHtml(p.name)}</option>`))
    .join('');
}

function onFeatureStore() {
  const slug = document.getElementById('store-select').value;
  if (slug) addFeatured('store', slug);
}

function onFeatureProduct() {
  const pid = document.getElementById('product-select').value;
  if (pid) addFeatured('product', pid);
}

async function addFeatured(type, refId) {
  const errorEl = document.getElementById('admin-error');
  errorEl.textContent = '';
  const res = await Api.post('addFeatured', { token: Auth.getToken(), type, refId });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not add that item.';
    return;
  }
  loadFeatured();
}

async function loadFeatured() {
  const statusEl = document.getElementById('featured-status');
  const listEl = document.getElementById('featured-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listFeatured', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const items = res.featured || [];
  if (items.length === 0) {
    listEl.innerHTML = '';
    statusEl.textContent = 'Nothing featured yet.';
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = items.map(featuredRow).join('');
  listEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(btn.dataset.remove));
  });
}

function featuredRow(f) {
  return `
    <div class="dash-item">
      <div class="dash-item-main">
        <strong>${escapeHtml(f.label)}</strong>
        <span class="helper-text">${escapeHtml(f.type)}</span>
      </div>
      <div class="dash-item-side">
        <button type="button" class="btn btn-small btn-danger" data-remove="${escapeHtml(f.featuredId)}">Remove</button>
      </div>
    </div>`;
}

async function onRemove(featuredId) {
  const res = await Api.post('removeFeatured', { token: Auth.getToken(), featuredId });
  if (res.ok) loadFeatured();
}

/* ---- Seller badges ---------------------------------------------------------
 *
 * Renders with the SAME .seller-badge component the storefront uses, plus
 * admin-only indicators beside it. A separate visual language for
 * administration would mean an admin checking what a shopper sees has to
 * translate between two of them.
 *
 * What is admin-only here is the information, not the styling: the score, the
 * order and reply figures, and the sentence explaining why each badge was
 * awarded. None of that appears in a customer response.
 */

let badgeSellers = [];
let badgeConfigValues = {};

async function loadSellerBadges() {
  const statusEl = document.getElementById('badge-status');
  const listEl = document.getElementById('badge-seller-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listSellerBadges', { token: Auth.getToken() });
  stop();

  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }

  badgeSellers = res.sellers || [];
  badgeConfigValues = res.config || {};
  statusEl.textContent = badgeSellers.length ? '' : 'No stores yet.';

  // The newest snapshot timestamp across all sellers - they are all written in
  // one pass, so any of them dates the whole table.
  const stamped = badgeSellers.map((s) => s.updatedAt).filter(Boolean).sort();
  document.getElementById('badge-updated').textContent = stamped.length
    ? 'Last worked out ' + new Date(stamped[stamped.length - 1]).toLocaleString()
    : 'Not worked out yet — press Recompute now.';

  listEl.innerHTML = badgeSellers.map(sellerBadgeRowHtml).join('');
  wireSellerBadgeControls();
  renderBadgeConfig();
}

/**
 * Every badge shown with its SOURCE, and every badge the data says they have
 * earned even when an override hides it.
 *
 * Showing only the result would hide the thing an admin most needs to know:
 * whether a store is decorated because it earned it or because someone pressed
 * a button.
 */
function sellerBadgeRowHtml(s) {
  const chip = (ids) => (typeof renderSellerBadges === 'function'
    ? renderSellerBadges(ids, { size: 'chip', interactive: false, labels: true }) : '');

  const shown = s.badges.length
    ? s.badges.map((id) => `
        <div class="badge-admin-item">
          ${chip([id])}
          <span class="badge-admin-source badge-admin-source--${s.source[id] === 'admin' ? 'admin' : 'auto'}">
            ${s.source[id] === 'admin' ? 'ADMIN OVERRIDE' : 'AUTO AWARDED'}
          </span>
          ${s.why[id] ? `<span class="helper-text badge-admin-why">${escapeHtml(s.why[id])}</span>` : ''}
        </div>`).join('')
    : '<p class="helper-text">No badges.</p>';

  // Earned but not shown - the case an admin needs spelled out rather than
  // inferred from an absence.
  const withheld = (s.autoBadges || []).filter((id) => s.badges.indexOf(id) === -1);
  const withheldHtml = withheld.length
    ? `<div class="badge-admin-item badge-admin-item--withheld">
         ${chip(withheld)}
         <span class="badge-admin-source badge-admin-source--withheld">EARNED, NOT SHOWN</span>
         <span class="helper-text badge-admin-why">${s.suppressed
           ? 'This store is hidden from all badges.' : 'Removed by an admin.'}</span>
       </div>`
    : '';

  const m = s.metrics || {};
  const figure = (label, value) => `<span><strong>${escapeHtml(String(value))}</strong> ${label}</span>`;

  return `
    <div class="dash-item badge-admin-row" data-owner-id="${escapeHtml(s.ownerId)}">
      <div class="badge-admin-head">
        <strong>${escapeHtml(s.storeName || s.storeSlug)}</strong>
        <span class="helper-text">${escapeHtml(s.storeSlug)}${s.status && s.status !== 'active' ? ' · ' + escapeHtml(s.status) : ''}</span>
      </div>

      <p class="helper-text badge-admin-figures">
        ${s.score === null ? '<span>Not enough data to score</span>' : figure('score', s.score)}
        ${figure('orders', m.orders || 0)}
        ${figure('fulfilled', m.fulfilled || 0)}
        ${figure('cancelled', m.cancelled || 0)}
        ${figure('reviews', m.reviews || 0)}
        ${m.rating != null ? figure('average', m.rating) : ''}
        ${m.medianReplyMinutes != null ? figure('min median reply', m.medianReplyMinutes) : ''}
        ${figure('repeat customers', m.repeatCustomers || 0)}
      </p>

      <div class="badge-admin-badges">${shown}${withheldHtml}</div>

      <div class="badge-admin-controls">
        ${overrideControl(s, 'verified', 'Verified Seller')}
        ${overrideControl(s, 'recommended', 'Mwakete Recommended')}
        <label class="badge-admin-suppress">
          <input type="checkbox" data-badge-suppress ${s.suppressed ? 'checked' : ''}>
          Hide all badges for this store
        </label>
      </div>
    </div>`;
}

/**
 * Three states, not two: granted, removed, and "leave it to the data".
 *
 * A plain on/off switch cannot express the third, and it is the one that
 * matters - clearing an override has to put a seller back under the automatic
 * rules rather than silently meaning "no".
 */
function overrideControl(s, field, label) {
  const current = s.overrides[field] || '';
  const opt = (v, text) =>
    `<option value="${v}"${current === v ? ' selected' : ''}>${text}</option>`;
  return `
    <label class="badge-admin-override">
      <span>${escapeHtml(label)}</span>
      <select data-badge-field="${field}">
        ${opt('', 'Automatic')}
        ${opt('true', 'Granted')}
        ${opt('false', 'Removed')}
      </select>
    </label>`;
}

function wireSellerBadgeControls() {
  document.querySelectorAll('.badge-admin-row').forEach((row) => {
    const ownerId = row.dataset.ownerId;
    row.querySelectorAll('[data-badge-field]').forEach((sel) => {
      sel.addEventListener('change', () =>
        setBadgeOverride(ownerId, sel.dataset.badgeField, sel.value, sel));
    });
    const box = row.querySelector('[data-badge-suppress]');
    if (box) {
      box.addEventListener('change', () =>
        setBadgeOverride(ownerId, 'suppressed', box.checked ? 'true' : '', box));
    }
  });
}

async function setBadgeOverride(ownerId, field, value, control) {
  const errorEl = document.getElementById('badge-error');
  errorEl.textContent = '';
  control.disabled = true;
  const res = await Api.post('setSellerBadgeOverride', {
    token: Auth.getToken(), ownerId, field, value
  });
  control.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not change that.';
    return;
  }
  // Reloaded rather than patched in place: the backend recomputes every store,
  // and a relative badge like Popular Seller can move between stores as a
  // result. Showing a stale table would be showing something untrue.
  loadSellerBadges();
}

/* ---- settings ---- */

function renderBadgeConfig() {
  const el = document.getElementById('badge-config-list');
  if (!el) return;
  const keys = Object.keys(badgeConfigValues).sort();
  el.innerHTML = keys.map((key) => {
    const value = badgeConfigValues[key];
    const isFlag = value === 'true' || value === 'false';
    const id = 'cfg-' + key.replace(/[^a-z0-9]/gi, '-');
    const input = isFlag
      ? `<select id="${id}" data-config-key="${escapeHtml(key)}">
           <option value="true"${value === 'true' ? ' selected' : ''}>On</option>
           <option value="false"${value === 'false' ? ' selected' : ''}>Off</option>
         </select>`
      : `<input id="${id}" type="number" step="any" min="0"
           data-config-key="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`;
    return `<div class="field badge-config-field">
        <label for="${id}">${escapeHtml(key)}</label>
        ${input}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-config-key]').forEach((input) => {
    input.addEventListener('change', () => saveBadgeConfig(input));
  });
}

async function saveBadgeConfig(input) {
  const errorEl = document.getElementById('badge-error');
  errorEl.textContent = '';
  input.disabled = true;
  const res = await Api.post('setBadgeConfig', {
    token: Auth.getToken(), key: input.dataset.configKey, value: input.value
  });
  input.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not save that setting.';
    return;
  }
  loadSellerBadges();
}

async function onRecomputeBadges() {
  const btn = document.getElementById('badge-recompute-btn');
  const errorEl = document.getElementById('badge-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Working…';
  const res = await Api.post('recomputeBadges', { token: Auth.getToken() });
  btn.disabled = false;
  btn.textContent = 'Recompute now';
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not recompute.';
    return;
  }
  loadSellerBadges();
}

/* ---------- Wholesaler verification ---------- */

async function loadWholesalers() {
  const statusEl = document.getElementById('wholesale-status');
  const listEl = document.getElementById('wholesale-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listWholesalers', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const list = res.wholesalers || [];
  statusEl.textContent = list.length ? '' : 'No wholesaler stores yet.';
  listEl.innerHTML = list.map(wholesalerRowHtml).join('');
  listEl.querySelectorAll('[data-verify]').forEach((btn) => {
    btn.addEventListener('click', () => setWholesaleVerified(btn.dataset.ownerId, btn.dataset.verify === 'true', btn));
  });
}

function wholesalerRowHtml(w) {
  const joined = w.createdAt ? new Date(w.createdAt).toLocaleDateString() : '';
  const phoneHref = String(w.phone || '').replace(/[^0-9+]/g, '');
  return `
    <div class="wholesale-row${w.verified ? ' is-verified' : ''}">
      <div class="wholesale-row-info">
        <strong>${escapeHtml(w.storeName)}</strong>
        ${w.storeType === 'distributor' ? '<span class="helper-text">Distributor</span>' : ''}
        <span class="status-badge ${w.verified ? 'status-active' : 'status-hidden'}">${w.verified ? 'Verified' : 'Call pending'}</span>
        <div class="helper-text">
          ${w.phone ? `<a href="tel:${escapeAttr(phoneHref)}">${escapeHtml(w.phone)}</a> · ` : ''}${escapeHtml(w.email || '')}${joined ? ' · joined ' + escapeHtml(joined) : ''}
        </div>
      </div>
      <button type="button" class="btn btn-small${w.verified ? '' : ' btn-primary'}" data-owner-id="${escapeAttr(w.ownerId)}" data-verify="${w.verified ? 'false' : 'true'}">
        ${w.verified ? 'Undo verification' : 'Mark Verified'}
      </button>
    </div>
  `;
}

async function setWholesaleVerified(ownerId, verified, btn) {
  const errorEl = document.getElementById('wholesale-error');
  errorEl.textContent = '';
  btn.disabled = true;
  const res = await Api.post('setWholesaleVerified', { token: Auth.getToken(), ownerId, verified });
  if (!res.ok) {
    btn.disabled = false;
    errorEl.textContent = res.error || 'Could not update that store.';
    return;
  }
  await loadWholesalers();
}

/* ---------- Featuring payments (Featuring.gs) ---------- */

async function loadFeaturePayments() {
  const statusEl = document.getElementById('feature-payments-status');
  const listEl = document.getElementById('feature-payments-list');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listFeaturePurchases', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const list = res.purchases || [];
  featureBankMatchDays = res.bankMatchDays || featureBankMatchDays;
  statusEl.textContent = list.length ? '' : 'No featuring payments yet.';
  renderUnmatchedSummary(list);
  listEl.innerHTML = list.map(featurePaymentRowHtml).join('');
  listEl.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', () => setFeaturePaymentStatus(btn.dataset.purchaseId, btn.dataset.approve === 'true', btn, btn.dataset.bankSeen === 'true'));
  });
  listEl.querySelectorAll('[data-bank]').forEach((btn) => {
    btn.addEventListener('click', () => setFeatureBankMatched(btn.dataset.purchaseId, btn.dataset.bank === 'true', btn));
  });
}

// Auto-approved paid featuring stops this many days after it starts unless
// ticked "Seen in bank" (Featuring.gs sweepFeatureBankMatches); sent by the server.
let featureBankMatchDays = 7;

// A screenshot can be edited; the bank statement can't. Paid purchases that
// are live (or waiting) but not yet ticked as seen in account 906149.
function needsBankMatch(p) {
  return Number(p.amount) > 0 && (p.status === 'Approved' || p.status === 'Pending review') && !p.bankMatchedAt;
}

function renderUnmatchedSummary(list) {
  const el = document.getElementById('feature-payments-unmatched');
  const todo = list.filter(needsBankMatch);
  if (!todo.length) {
    el.textContent = list.some((p) => p.bankMatchedAt) ? 'All paid featuring is matched to the bank.' : '';
    el.className = 'feature-unmatched';
    return;
  }
  const total = todo.reduce((sum, p) => sum + Number(p.amount), 0);
  el.textContent = `${todo.length} payment${todo.length === 1 ? '' : 's'} (${formatMoney(total)}) not yet matched to the bank. `
    + 'Check each reference and amount arrived in the account, then tick "Seen in bank".';
  el.className = 'feature-unmatched is-todo';
}

const FEATURE_STATUS_BADGE = { 'Approved': 'status-active', 'Pending review': 'status-pending', 'Rejected': 'status-declined', 'Stopped': 'status-declined' };

function featurePaymentRowHtml(p) {
  const when = p.endsAt && p.status === 'Approved' ? ' · until ' + new Date(p.endsAt).toLocaleDateString() : '';
  const canApprove = p.status === 'Pending review' || p.status === 'Rejected' || p.status === 'Stopped';
  const canReject = p.status === 'Pending review' || p.status === 'Approved';
  const free = Number(p.amount) === 0;
  const matchable = !free && (p.status === 'Approved' || p.status === 'Pending review');
  // A paid purchase approved by a person needs the money seen first - one
  // button does both (Featuring.gs actionSetFeaturePurchaseStatus).
  const approveNeedsBank = !free && !p.bankMatchedAt;
  const stopsOn = p.status === 'Approved' && p.startsAt && !p.bankMatchedAt && !free
    ? new Date(new Date(p.startsAt).getTime() + featureBankMatchDays * 86400000) : null;
  const bankLine = p.status === 'Stopped'
    ? '<div class="helper-text feature-bank-todo">Stopped - not seen in the bank in time</div>'
    : !matchable ? ''
    : p.bankMatchedAt
      ? `<div class="helper-text feature-bank-ok">✓ Seen in bank ${escapeHtml(new Date(p.bankMatchedAt).toLocaleDateString())}</div>`
      : `<div class="helper-text feature-bank-todo">Not yet matched to the bank${stopsOn ? ` - stops ${escapeHtml(stopsOn.toLocaleDateString())} unless ticked` : ''}</div>`;
  return `
    <div class="wholesale-row feature-payment-row">
      <div class="wholesale-row-info">
        <strong>${escapeHtml(p.storeName || '')}</strong>
        <span class="status-badge ${FEATURE_STATUS_BADGE[p.status] || 'status-hidden'}">${escapeHtml(p.status)}</span>
        <div class="helper-text">
          ${free ? 'Free' : escapeHtml(formatMoney(p.amount))} · ref ${escapeHtml(p.reference)} · ${p.days} day${p.days === 1 ? '' : 's'}${escapeHtml(when)}
        </div>
        <div class="helper-text">${escapeHtml((p.productNames || []).join(', '))}</div>
        ${p.ocrNotes ? `<div class="helper-text feature-payment-notes">${escapeHtml(p.ocrNotes)}</div>` : ''}
        ${bankLine}
        ${p.screenshotUrl ? `<a href="${escapeAttr(p.screenshotUrl)}" target="_blank" rel="noopener">View screenshot</a>` : ''}
      </div>
      <div class="feature-payment-actions">
        ${canApprove ? `<button type="button" class="btn btn-small btn-primary" data-purchase-id="${escapeAttr(p.purchaseId)}" data-approve="true"${approveNeedsBank ? ' data-bank-seen="true"' : ''}>${approveNeedsBank ? 'Seen in bank &amp; approve' : 'Approve'}</button>` : ''}
        ${canReject ? `<button type="button" class="btn btn-small" data-purchase-id="${escapeAttr(p.purchaseId)}" data-approve="false">Reject</button>` : ''}
        ${matchable ? (p.bankMatchedAt
          ? `<button type="button" class="btn btn-small btn-light-purple" data-purchase-id="${escapeAttr(p.purchaseId)}" data-bank="false">Undo bank tick</button>`
          : `<button type="button" class="btn btn-small btn-light-purple" data-purchase-id="${escapeAttr(p.purchaseId)}" data-bank="true">✓ Seen in bank</button>`) : ''}
      </div>
    </div>
  `;
}

async function setFeaturePaymentStatus(purchaseId, approve, btn, bankSeen) {
  const errorEl = document.getElementById('feature-payments-error');
  errorEl.textContent = '';
  if (!approve && !window.confirm('Reject this payment? If it was approved, the products stop being featured now.')) return;
  if (approve && bankSeen && !window.confirm('Have you seen this payment (reference and amount) arrive in the Mwakete bank account?')) return;
  btn.disabled = true;
  const res = await Api.post('setFeaturePurchaseStatus', { token: Auth.getToken(), purchaseId, approve, bankSeen: !!bankSeen });
  if (!res.ok) {
    btn.disabled = false;
    errorEl.textContent = res.error || 'Could not update that payment.';
    return;
  }
  await loadFeaturePayments();
}

async function setFeatureBankMatched(purchaseId, matched, btn) {
  const errorEl = document.getElementById('feature-payments-error');
  errorEl.textContent = '';
  btn.disabled = true;
  const res = await Api.post('setFeatureBankMatched', { token: Auth.getToken(), purchaseId, matched });
  if (!res.ok) {
    btn.disabled = false;
    errorEl.textContent = res.error || 'Could not update that payment.';
    return;
  }
  await loadFeaturePayments();
}

/* ---------- Find a store or product + store analytics ---------- */

let adminSearchTimer = null;
let adminSearchSeq = 0;

function initAdminSearch() {
  const input = document.getElementById('admin-search-input');
  input.addEventListener('input', () => {
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => runAdminSearch(input.value.trim()), 300);
  });
  // Enter searches at once - a pasted reference shouldn't wait for the pause.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(adminSearchTimer);
    runAdminSearch(input.value.trim());
  });
  document.getElementById('admin-search-results').addEventListener('click', (e) => {
    const hit = e.target.closest('.admin-search-hit');
    if (!hit) return;
    if (hit.dataset.order) return showOrderHit(hit.dataset.order);
    if (hit.dataset.payment) return showPaymentHit(hit.dataset.payment);
    if (hit.dataset.case) return openCaseHit(hit.dataset.case);
    if (hit.dataset.ownerId) loadStoreAnalytics(hit.dataset.ownerId, hit.dataset.productId || '');
  });
  document.getElementById('admin-analytics').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-store]');
    if (btn) loadStoreAnalytics(btn.dataset.openStore, '');
    const jump = e.target.closest('[data-jump-payment]');
    if (jump) highlightFeaturePayment(jump.dataset.jumpPayment);
  });
}

// The last results, so a click can show a record without another request.
let adminSearchLast = null;

async function runAdminSearch(q) {
  const statusEl = document.getElementById('admin-search-status');
  const listEl = document.getElementById('admin-search-results');
  const seq = ++adminSearchSeq;
  if (q.length < 2) {
    statusEl.textContent = '';
    listEl.innerHTML = '';
    return;
  }
  statusEl.textContent = 'Searching…';
  const res = await Api.post('adminSearch', { token: Auth.getToken(), q });
  if (seq !== adminSearchSeq) return; // a newer search has started - drop this one
  if (!res.ok) {
    statusEl.textContent = res.error || 'Search failed. Please try again.';
    listEl.innerHTML = '';
    return;
  }
  adminSearchLast = res;
  const stores = res.stores || [];
  const products = res.products || [];
  const orders = res.orders || [];
  const payments = res.payments || [];
  const cases = res.cases || [];
  const total = stores.length + products.length + orders.length + payments.length + cases.length;
  statusEl.textContent = total ? `${total} result${total === 1 ? '' : 's'}${res.phone ? ' for that phone number' : ''}.` : `Nothing matches "${q}".`;
  const group = (title, items, row) => (items.length ? `<h3>${title} <span class="helper-text">(${items.length})</span></h3>${items.map(row).join('')}` : '');
  const status = (st) => (st && st !== 'active' ? ' · ' + escapeHtml(st) : '');
  listEl.innerHTML =
    group('Stores', stores, (s) => `
      <button type="button" class="admin-search-hit" data-owner-id="${escapeAttr(s.ownerId)}">
        <strong>${escapeHtml(s.storeName)}</strong>
        <span class="helper-text">${escapeHtml(s.storeSlug)}${status(s.status)}</span>
      </button>`) +
    group('Products', products, (p) => `
      <button type="button" class="admin-search-hit" data-owner-id="${escapeAttr(p.ownerId)}" data-product-id="${escapeAttr(p.productId)}">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="helper-text">${escapeHtml(p.storeName)}${status(p.status)}</span>
      </button>`) +
    group('Orders', orders, (o) => `
      <button type="button" class="admin-search-hit" data-order="${escapeAttr(o.orderId)}">
        <strong>${escapeHtml(o.orderId)}</strong>
        <span class="helper-text">${escapeHtml([o.customerName, o.storeName, o.status, formatMoney(o.total), String(o.createdAt || '').slice(0, 10)].filter(Boolean).join(' · '))}</span>
      </button>`) +
    group('Featuring payments', payments, (p) => `
      <button type="button" class="admin-search-hit" data-payment="${escapeAttr(p.reference)}">
        <strong>${escapeHtml(p.reference)}</strong>
        <span class="helper-text">${escapeHtml([p.storeName, p.status, Number(p.amount) === 0 ? 'Free' : formatMoney(p.amount), String(p.createdAt || '').slice(0, 10)].filter(Boolean).join(' · '))}</span>
      </button>`) +
    group('Listing review cases', cases, (c) => `
      <button type="button" class="admin-search-hit" data-case="${escapeAttr(c.reviewId)}">
        <strong>${escapeHtml(c.productName || c.reviewId)}</strong>
        <span class="helper-text">${escapeHtml([c.caseType === 'CATEGORY_REQUEST' ? 'Category request' : 'Listing', c.storeName, c.status, c.severity].filter(Boolean).join(' · '))}</span>
      </button>`);

  // Shortcut: an exact order number, payment reference or case id opens it.
  if (res.exact) {
    statusEl.textContent = `Opened ${res.exact.id}.`;
    if (res.exact.type === 'order') showOrderHit(res.exact.id);
    else if (res.exact.type === 'payment') showPaymentHit(res.exact.id);
    else if (res.exact.type === 'case') openCaseHit(res.exact.id);
  }
}

function showRecordPanel(html) {
  const el = document.getElementById('admin-analytics');
  el.classList.remove('hidden');
  el.innerHTML = html;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** One order: what the admin needs to recognise it, and its store. */
function showOrderHit(orderId) {
  const o = adminSearchLast && (adminSearchLast.orders || []).find((x) => x.orderId === orderId);
  if (!o) return;
  showRecordPanel(`<div class="admin-analytics-head"><h3>Order ${escapeHtml(o.orderId)}</h3></div>
    <dl class="admin-record">
      <dt>Store</dt><dd>${escapeHtml(o.storeName)}</dd>
      <dt>Customer</dt><dd>${escapeHtml(o.customerName)}${o.customerPhone ? ' · ' + escapeHtml(o.customerPhone) : ''}</dd>
      <dt>Status</dt><dd>${escapeHtml(o.status)}</dd>
      <dt>Total</dt><dd>${escapeHtml(formatMoney(o.total))}</dd>
      <dt>Placed</dt><dd>${escapeHtml(o.createdAt ? new Date(o.createdAt).toLocaleString() : '')}</dd>
      <dt>Items</dt><dd>${escapeHtml(o.itemsSummary)}</dd>
    </dl>
    <p><button type="button" class="btn btn-small" data-open-store="${escapeAttr(o.ownerId)}">Open this store</button></p>`);
}

/** One featuring payment, with a jump to its row (and its buttons) below. */
function showPaymentHit(reference) {
  const p = adminSearchLast && (adminSearchLast.payments || []).find((x) => x.reference === reference);
  if (!p) return;
  showRecordPanel(`<div class="admin-analytics-head"><h3>Featuring payment ${escapeHtml(p.reference)}</h3></div>
    <dl class="admin-record">
      <dt>Store</dt><dd>${escapeHtml(p.storeName)}</dd>
      <dt>Status</dt><dd>${escapeHtml(p.status)}</dd>
      <dt>Amount</dt><dd>${Number(p.amount) === 0 ? 'Free' : escapeHtml(formatMoney(p.amount))}</dd>
      <dt>Started</dt><dd>${escapeHtml(p.createdAt ? new Date(p.createdAt).toLocaleString() : '')}</dd>
    </dl>
    <p><button type="button" class="btn btn-small btn-light-purple" data-jump-payment="${escapeAttr(p.reference)}">Show in Featuring payments</button>
       <button type="button" class="btn btn-small" data-open-store="${escapeAttr(p.ownerId)}">Open this store</button></p>`);
}

function highlightFeaturePayment(reference) {
  const rows = Array.from(document.querySelectorAll('#feature-payments-list > *'));
  const row = rows.find((r) => r.textContent.indexOf('ref ' + reference) !== -1);
  const target = row || document.getElementById('feature-payments-heading');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (row) {
    row.classList.remove('admin-flash');
    void row.offsetWidth;
    row.classList.add('admin-flash');
  }
}

function openCaseHit(reviewId) {
  if (typeof ListingReviewAdmin !== 'undefined') ListingReviewAdmin.openById(reviewId);
}

/** Section menu: marks the section on screen, so the menu shows where you are. */
function initAdminJump() {
  const links = Array.from(document.querySelectorAll('.admin-jump a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  const byId = {};
  links.forEach((a) => { byId[a.getAttribute('href').slice(1)] = a; });
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((a) => a.removeAttribute('aria-current'));
      const a = byId[en.target.id];
      if (a) {
        a.setAttribute('aria-current', 'true');
        a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }, { rootMargin: '-50px 0px -65% 0px' });
  Object.keys(byId).forEach((id) => { const h = document.getElementById(id); if (h) seen.observe(h); });
  // A tap marks its entry at once, before the scroll settles.
  links.forEach((a) => a.addEventListener('click', () => {
    links.forEach((x) => x.removeAttribute('aria-current'));
    a.setAttribute('aria-current', 'true');
  }));
}

async function loadStoreAnalytics(ownerId, productId) {
  const el = document.getElementById('admin-analytics');
  el.classList.remove('hidden');
  el.innerHTML = '<p class="helper-text">Loading store details…</p>';
  const res = await Api.post('adminStoreAnalytics', { token: Auth.getToken(), ownerId });
  if (!res.ok) {
    el.innerHTML = `<p class="form-error">${escapeHtml(res.error || 'Could not load this store.')}</p>`;
    return;
  }
  el.innerHTML = storeAnalyticsHtml(res.analytics, productId);
  const hit = productId && el.querySelector('.is-picked');
  (hit || el).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function statusCountsHtml(byStatus) {
  const keys = Object.keys(byStatus || {});
  return keys.length ? keys.map((k) => `${escapeHtml(k)} ${byStatus[k]}`).join(' · ') : 'none yet';
}

function storeAnalyticsHtml(a, pickedProductId) {
  const s = a.store;
  const joined = s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '';
  const phoneHref = String(s.phone || '').replace(/[^0-9+]/g, '');
  const type = s.storeType === 'retailer' ? 'Retailer'
    : `${s.storeType === 'distributor' ? 'Distributor' : 'Wholesaler'}${s.wholesaleVerified ? ' (verified)' : ' (call pending)'}`;
  const stat = (label, value) => `<div class="admin-stat"><span class="admin-stat-value">${value}</span><span class="admin-stat-label">${label}</span></div>`;
  const rows = a.products.map((p) => `
    <tr class="${p.productId === pickedProductId ? 'is-picked' : ''}">
      <td>${escapeHtml(p.name)}${p.status !== 'active' ? ` <span class="helper-text">(${escapeHtml(p.status)})</span>` : ''}</td>
      <td>${p.minPrice == null ? '-' : escapeHtml(formatMoney(p.minPrice))}</td>
      <td>${p.stock == null ? '-' : p.stock}</td>
      <td>${p.views}</td>
    </tr>`).join('');
  const featuring = a.featuring.recent.map((f) => `
    <li>${escapeHtml(f.reference)} · ${escapeHtml(f.status)} · ${escapeHtml(formatMoney(f.amount))} for ${f.days} day${f.days === 1 ? '' : 's'}${f.endsAt ? ' · ends ' + escapeHtml(new Date(f.endsAt).toLocaleDateString()) : ''}</li>`).join('');
  return `
    <div class="admin-analytics-head">
      <h3>${escapeHtml(s.storeName)}</h3>
      <a href="../store.html?store=${encodeURIComponent(s.storeSlug)}" target="_blank" rel="noopener">View store</a>
    </div>
    <p class="helper-text">
      ${escapeHtml(type)} · ${escapeHtml(s.status)}${s.adminFeatured ? ' · featured by admin' : ''}${joined ? ' · joined ' + escapeHtml(joined) : ''}<br>
      ${s.phone ? `<a href="tel:${escapeAttr(phoneHref)}">${escapeHtml(s.phone)}</a> · ` : ''}${s.email ? `<a href="mailto:${escapeAttr(s.email)}">${escapeHtml(s.email)}</a> · ` : ''}${escapeHtml([s.village, s.island].filter(Boolean).join(', '))}
    </p>
    <div class="admin-stats">
      ${stat('store visits', s.visits)}
      ${stat('product views', a.totals.views)}
      ${stat('orders', a.orders.count)}
      ${stat('sales (paid)', escapeHtml(formatMoney(a.orders.sales)))}
      ${stat('bookings', a.bookings.count)}
      ${stat('rating', a.reviews.average == null ? '-' : a.reviews.average + ' ★ (' + a.reviews.count + ')')}
      ${stat('featuring spend', escapeHtml(formatMoney(a.featuring.spent)))}
    </div>
    <p class="helper-text"><strong>Orders:</strong> ${statusCountsHtml(a.orders.byStatus)}<br>
      <strong>Bookings:</strong> ${statusCountsHtml(a.bookings.byStatus)}</p>
    <h4>Products (${a.totals.activeProducts} active of ${a.totals.products}), most viewed first</h4>
    ${a.products.length ? `<div class="admin-table-wrap"><table class="admin-table">
      <thead><tr><th>Product</th><th>From</th><th>Stock</th><th>Views</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<p class="helper-text">No products yet.</p>'}
    <h4>Paid featuring${a.featuring.activeNow ? ' <span class="status-badge status-active">featured now</span>' : ''}</h4>
    ${featuring ? `<ul class="admin-featuring-list">${featuring}</ul>` : '<p class="helper-text">No featuring purchases.</p>'}
  `;
}

/* ---------- Inventory & sync monitoring ---------- */

const SYNC_SOURCE_LABELS = { csv: 'CSV (saved matching)', googleSheets: 'Google Sheets', microsoftExcel: 'Excel / OneDrive', customApi: 'Other system' };

async function loadInventoryOverview() {
  const statusEl = document.getElementById('inv-admin-status');
  const el = document.getElementById('inv-admin');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('adminInventoryOverview', { token: Auth.getToken() });
  stop();
  if (!res.ok || !res.overview) { showLoadFailedMessage(statusEl); return; }
  statusEl.textContent = '';
  const o = res.overview;
  const stat = (value, label) => `<div class="admin-stat"><span class="admin-stat-value">${value}</span><span class="admin-stat-label">${label}</span></div>`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
  const byType = Object.keys(o.connections.byType).map((k) => `${escapeHtml(SYNC_SOURCE_LABELS[k] || k)} ${o.connections.byType[k]}`).join(' · ') || 'none yet';
  el.innerHTML = `
    <div class="admin-stats">
      ${stat(o.businessTypes.retailer, 'retailers')}
      ${stat(o.businessTypes.wholesaler, 'wholesalers')}
      ${stat(o.businessTypes.distributor, 'distributors')}
      ${stat(o.trackingStock, 'stores tracking stock')}
      ${stat(o.connectedBusinesses, 'stores with a connection')}
      ${stat(o.connections.total, 'active connections')}
      ${stat(o.connections.failing, 'failing connections')}
      ${stat(o.openConflicts, 'open conflicts')}
      ${stat(o.productsSynced, 'items synced')}
      ${stat(o.syncsLast7Days, 'syncs, last 7 days')}
    </div>
    <p class="helper-text"><strong>Connections:</strong> ${byType}<br><strong>Last successful sync:</strong> ${escapeHtml(when(o.lastSuccessfulSync))}</p>
    <h3>Failing connections</h3>
    ${o.failingConnections.length ? `<ul class="admin-featuring-list">${o.failingConnections.map((c) => `<li><strong>${escapeHtml(c.store)}</strong> - ${escapeHtml(c.name)} (${escapeHtml(SYNC_SOURCE_LABELS[c.type] || c.type)}), since ${escapeHtml(when(c.since))}: ${escapeHtml(c.error)}</li>`).join('')}</ul>` : '<p class="helper-text">None.</p>'}
    <h3>Recent sync failures</h3>
    ${o.recentFailures.length ? `<ul class="admin-featuring-list">${o.recentFailures.map((f) => `<li>${escapeHtml(when(f.at))} · <strong>${escapeHtml(f.store)}</strong> (${escapeHtml(SYNC_SOURCE_LABELS[f.type] || f.type)}): ${escapeHtml(f.error)}</li>`).join('')}</ul>` : '<p class="helper-text">None.</p>'}`;
}
