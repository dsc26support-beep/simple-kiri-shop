// Seller inventory (owner/inventory.html): stock list with health, receive,
// adjust, low-stock settings and the movement history. All stock rules are
// server-side (apps-script/Inventory.gs); this page only shows and asks.
document.addEventListener('DOMContentLoaded', init);

const HEALTH = {
  healthy: { label: 'In stock', cls: 'is-healthy' },
  low: { label: 'Low stock', cls: 'is-low' },
  out: { label: 'Out of stock', cls: 'is-out' },
  untracked: { label: 'Not tracked', cls: 'is-untracked' }
};
const MOVEMENT_LABELS = {
  INITIAL_STOCK: 'Stock set', STOCK_RECEIVED: 'Received', SALE: 'Sold', ORDER_RESERVED: 'Held for order',
  ORDER_RELEASED: 'Order cancelled - released', RETURN: 'Returned', DAMAGED: 'Damaged', EXPIRED: 'Expired',
  MANUAL_ADJUSTMENT: 'Count correction', STOCK_TRANSFER: 'Transfer', EXTERNAL_SYNC: 'Synced', SYNC_CORRECTION: 'Sync correction'
};

let items = [];
let filter = 'all';
let historyOffset = 0;
let historyVariant = '';
let saving = false;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;
  document.getElementById('inv-search').addEventListener('input', renderList);
  document.querySelectorAll('.inv-chip').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  document.getElementById('inv-list').addEventListener('click', onListClick);
  document.getElementById('inv-history-more').addEventListener('click', () => loadHistory(false));
  await loadInventory();
  loadHistory(true);
}

async function loadInventory() {
  const statusEl = document.getElementById('inv-status');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('getInventory', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  statusEl.textContent = '';
  items = res.items || [];
  renderSummary(res.summary);
  renderMore(res.capabilities || {});
  renderList();
}

function renderSummary(s) {
  const el = document.getElementById('inv-summary');
  const tile = (value, label, f) => `<button type="button" class="inv-tile${f ? ' inv-tile--' + f : ''}" ${f ? `data-filter="${f}"` : 'disabled'}>
    <span class="inv-tile-value">${value}</span><span class="inv-tile-label">${label}</span></button>`;
  el.innerHTML =
    tile(s.tracked, 'tracked items') +
    tile(s.low, 'low stock', 'low') +
    tile(s.out, 'out of stock', 'out') +
    tile(s.reservedUnits, 'held by orders') +
    tile(formatMoney(s.stockValue) + (s.valueIsPartial ? '*' : ''), 'stock value (cost)');
  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  el.classList.remove('hidden');
  if (s.valueIsPartial) el.title = '* Some items have no cost price yet, so they are not counted in the value.';
}

// Progressive: retailers see only the basics; wholesalers and distributors
// get links to the extra tools as those screens exist.
function renderMore(caps) {
  const links = [];
  if (caps.sync) links.push('<a class="btn btn-light-purple btn-small" href="inventory-sync.html">Import / Sync</a>');
  const el = document.getElementById('inv-more');
  el.innerHTML = links.join(' ');
  el.classList.toggle('hidden', links.length === 0);
}

function setFilter(f) {
  filter = f;
  document.querySelectorAll('.inv-chip').forEach((b) => {
    const on = b.dataset.filter === f;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderList();
}

function visibleItems() {
  const q = document.getElementById('inv-search').value.trim().toLowerCase();
  return items.filter((i) => (filter === 'all' || i.health === filter) &&
    (!q || [i.productName, i.label, i.sku, i.barcode].some((t) => String(t || '').toLowerCase().includes(q))));
}

function renderList() {
  const el = document.getElementById('inv-list');
  if (items.length === 0) {
    el.innerHTML = '<p class="helper-text">No products yet. <a href="products.html">Add a product</a> and its stock will show here.</p>';
    return;
  }
  const list = visibleItems();
  if (list.length === 0) {
    el.innerHTML = '<p class="helper-text">Nothing matches.</p>';
    return;
  }
  el.innerHTML = list.map((i) => {
    const h = HEALTH[i.health] || HEALTH.untracked;
    const numbers = i.tracked
      ? `<span><strong>${i.available}</strong> available</span><span>${i.physical} in stock</span>${i.reserved ? `<span>${i.reserved} held</span>` : ''}`
      : '<span>Unlimited (stock not tracked)</span>';
    return `
      <div class="inv-row" data-variant-id="${escapeAttr(i.variantId)}">
        <div class="inv-row-main">
          <span class="inv-health ${h.cls}">${h.label}</span>
          <strong>${escapeHtml(i.productName)}</strong> <span class="helper-text">${escapeHtml(i.label)}</span>
          <div class="inv-row-numbers">${numbers}</div>
          ${i.sku || i.barcode ? `<div class="helper-text">${i.sku ? 'SKU ' + escapeHtml(i.sku) : ''}${i.sku && i.barcode ? ' · ' : ''}${i.barcode ? 'Barcode ' + escapeHtml(i.barcode) : ''}</div>` : ''}
          ${i.health === 'low' ? `<div class="inv-hint">Low: at or below your level of ${i.reorderLevel}.${i.reorderQty ? ' You usually reorder ' + i.reorderQty + '.' : ''}</div>` : ''}
        </div>
        <div class="inv-row-actions">
          <button type="button" class="btn btn-small btn-primary" data-act="receive">Receive</button>
          <button type="button" class="btn btn-small" data-act="adjust">Adjust</button>
          <button type="button" class="btn btn-small" data-act="settings">Settings</button>
          <button type="button" class="btn btn-small" data-act="history">History</button>
        </div>
      </div>`;
  }).join('');
}

function onListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = items.find((i) => i.variantId === btn.closest('.inv-row').dataset.variantId);
  if (!item) return;
  if (btn.dataset.act === 'history') {
    historyVariant = item.variantId;
    loadHistory(true, `${item.productName} - ${item.label}`);
    document.getElementById('inv-history-heading').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  openPanel(btn.dataset.act, item);
}

/* ---------- action panel ---------- */

function newRequestId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function openPanel(kind, item) {
  const panel = document.getElementById('inv-panel');
  const form = document.getElementById('inv-form');
  document.getElementById('inv-panel-error').textContent = '';
  document.getElementById('inv-panel-saved').classList.add('hidden');
  document.getElementById('inv-panel-title').textContent =
    { receive: 'Receive stock', adjust: 'Adjust stock', settings: 'Stock settings' }[kind] + ': ' + item.productName + ' - ' + item.label;
  document.getElementById('inv-panel-sub').textContent = item.tracked
    ? `Now: ${item.physical} in stock, ${item.reserved} held by orders, ${item.available} available.`
    : 'Stock is not tracked yet - receiving or counting stock turns tracking on.';
  // A fresh id per opened form: a double tap or a retry reuses it, so the
  // server applies the change once (Inventory.gs inventoryReplay).
  form.dataset.requestId = newRequestId();
  form.dataset.kind = kind;
  form.dataset.variantId = item.variantId;

  if (kind === 'receive') {
    form.innerHTML = `
      ${field('inv-qty', 'Units received', `<input id="inv-qty" type="number" inputmode="numeric" min="1" step="1" required>`)}
      ${field('inv-supplier', 'Supplier (optional)', `<input id="inv-supplier" type="text" maxlength="100" autocomplete="organization">`)}
      ${field('inv-invoice', 'Invoice / reference (optional)', `<input id="inv-invoice" type="text" maxlength="60">`)}
      ${field('inv-cost', 'Cost per unit (optional)', `<input id="inv-cost" type="number" inputmode="decimal" min="0" step="0.01" value="${item.costPrice == null ? '' : item.costPrice}">`)}
      ${buttons('Add to stock')}`;
  } else if (kind === 'adjust') {
    form.innerHTML = `
      ${field('inv-reason', 'What happened?', `<select id="inv-reason">
        <option value="count">I counted it - set the exact number</option>
        <option value="damaged">Damaged - remove units</option>
        <option value="expired">Expired - remove units</option>
        <option value="returned">Customer return - add units back</option></select>`)}
      ${field('inv-count', 'Number you counted', `<input id="inv-count" type="number" inputmode="numeric" min="0" step="1" value="${item.tracked ? item.physical : ''}">`, 'inv-count-field')}
      ${field('inv-qty', 'How many units', `<input id="inv-qty" type="number" inputmode="numeric" min="1" step="1">`, 'inv-qty-field hidden')}
      ${field('inv-notes', 'Note (optional)', `<input id="inv-notes" type="text" maxlength="200">`)}
      ${buttons('Save change')}`;
    form.querySelector('#inv-reason').addEventListener('change', (e) => {
      const count = e.target.value === 'count';
      form.querySelector('.inv-count-field').classList.toggle('hidden', !count);
      form.querySelector('.inv-qty-field').classList.toggle('hidden', count);
    });
  } else {
    form.innerHTML = `
      ${field('inv-level', 'Warn me when available stock is at or below', `<input id="inv-level" type="number" inputmode="numeric" min="0" step="1" value="${item.reorderLevel == null ? '' : item.reorderLevel}">`)}
      ${field('inv-reorder', 'I usually reorder (units)', `<input id="inv-reorder" type="number" inputmode="numeric" min="0" step="1" value="${item.reorderQty == null ? '' : item.reorderQty}">`)}
      ${field('inv-sku', 'SKU / item code', `<input id="inv-sku" type="text" maxlength="64" value="${escapeAttr(item.sku)}">`)}
      ${field('inv-barcode', 'Barcode', `<input id="inv-barcode" type="text" inputmode="numeric" maxlength="64" value="${escapeAttr(item.barcode)}">`)}
      ${field('inv-costp', 'Cost price per unit', `<input id="inv-costp" type="number" inputmode="decimal" min="0" step="0.01" value="${item.costPrice == null ? '' : item.costPrice}">`)}
      ${buttons('Save settings')}`;
  }
  form.onsubmit = (e) => { e.preventDefault(); submitPanel(); };
  form.querySelector('[data-cancel]').addEventListener('click', closePanel);
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const first = form.querySelector('input, select');
  if (first) first.focus({ preventScroll: true });
}

function field(id, label, control, cls) {
  return `<div class="field${cls ? ' ' + cls : ''}"><label for="${id}">${label}</label>${control}</div>`;
}

function buttons(primary) {
  return `<div class="inv-panel-buttons"><button type="submit" class="btn btn-primary" id="inv-submit">${primary}</button>
    <button type="button" class="btn" data-cancel>Cancel</button></div>`;
}

function closePanel() {
  document.getElementById('inv-panel').classList.add('hidden');
}

async function submitPanel() {
  if (saving) return; // no duplicate submissions
  const form = document.getElementById('inv-form');
  const errEl = document.getElementById('inv-panel-error');
  const savedEl = document.getElementById('inv-panel-saved');
  const btn = document.getElementById('inv-submit');
  const val = (id) => { const x = form.querySelector('#' + id); return x ? x.value.trim() : ''; };
  const kind = form.dataset.kind;
  const base = { token: Auth.getToken(), variantId: form.dataset.variantId, requestId: form.dataset.requestId };
  let action, payload;
  if (kind === 'receive') {
    if (!(Number(val('inv-qty')) > 0)) { errEl.textContent = 'Enter how many units arrived.'; return; }
    action = 'receiveStock';
    payload = { quantity: val('inv-qty'), supplier: val('inv-supplier'), invoice: val('inv-invoice'), unitCost: val('inv-cost') };
  } else if (kind === 'adjust') {
    const reason = val('inv-reason');
    action = 'adjustStock';
    payload = { reason, newCount: val('inv-count'), quantity: val('inv-qty'), notes: val('inv-notes') };
  } else {
    action = 'updateStockSettings';
    payload = { reorderLevel: val('inv-level'), reorderQty: val('inv-reorder'), sku: val('inv-sku'), barcode: val('inv-barcode'), costPrice: val('inv-costp') };
  }

  errEl.textContent = '';
  savedEl.classList.add('hidden');
  saving = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Saving…';
  let res;
  try {
    res = await Api.post(action, Object.assign(base, payload));
  } catch (e) {
    res = { ok: false, error: '' };
  }
  saving = false;
  btn.disabled = false;
  btn.textContent = label;
  if (!res || !res.ok) {
    // Never claim success the server didn't confirm. A dropped connection
    // can't say whether the change landed, so it doesn't pretend either way:
    // the same request id is kept, and the server applies it at most once.
    const offline = !res || !res.error || /^Network error/.test(res.error);
    errEl.textContent = offline
      ? 'We couldn\'t reach Mwakete to confirm this change. Check your connection and press the button again - it is safe, the change will only ever be applied once.'
      : res.error;
    return;
  }
  const idx = items.findIndex((i) => i.variantId === res.item.variantId);
  if (idx !== -1) items[idx] = res.item;
  renderList();
  savedEl.textContent = 'Saved. ' + (res.item.tracked ? `${res.item.physical} in stock, ${res.item.available} available.` : '');
  savedEl.classList.remove('hidden');
  form.dataset.requestId = newRequestId();
  if (kind !== 'settings') loadHistory(true);
  refreshSummary();
}

// Recount the tiles from the list we already have - no extra request.
function refreshSummary() {
  const tracked = items.filter((i) => i.tracked);
  renderSummary({
    tracked: tracked.length,
    low: items.filter((i) => i.health === 'low').length,
    out: items.filter((i) => i.health === 'out').length,
    reservedUnits: tracked.reduce((s, i) => s + i.reserved, 0),
    stockValue: Math.round(tracked.reduce((s, i) => s + (i.costPrice == null ? 0 : i.costPrice * i.physical), 0) * 100) / 100,
    valueIsPartial: tracked.some((i) => i.costPrice == null && i.physical > 0)
  });
}

/* ---------- history ---------- */

async function loadHistory(reset, filterLabel) {
  const el = document.getElementById('inv-history');
  const more = document.getElementById('inv-history-more');
  const filterEl = document.getElementById('inv-history-filter');
  if (reset) {
    historyOffset = 0;
    el.innerHTML = '<p class="helper-text">Loading…</p>';
  }
  if (filterLabel !== undefined || reset) {
    if (historyVariant && filterLabel) {
      filterEl.innerHTML = `Showing: ${escapeHtml(filterLabel)} · <a href="#" id="inv-history-all">show all</a>`;
      filterEl.classList.remove('hidden');
      filterEl.querySelector('#inv-history-all').addEventListener('click', (e) => { e.preventDefault(); historyVariant = ''; filterEl.classList.add('hidden'); loadHistory(true); });
    } else if (!historyVariant) {
      filterEl.classList.add('hidden');
    }
  }
  const res = await Api.post('listStockMovements', { token: Auth.getToken(), variantId: historyVariant, offset: historyOffset, limit: 30 });
  if (!res.ok) {
    if (reset) el.innerHTML = '<p class="helper-text">Could not load the history. Please refresh.</p>';
    return;
  }
  const rows = (res.movements || []).map(historyRowHtml).join('');
  if (reset) el.innerHTML = rows || '<p class="helper-text">No stock changes yet.</p>';
  else el.insertAdjacentHTML('beforeend', rows);
  historyOffset += (res.movements || []).length;
  more.classList.toggle('hidden', !res.hasMore);
}

function historyRowHtml(m) {
  const when = m.createdAt ? new Date(m.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const sign = m.quantity > 0 ? '+' : '';
  const stock = m.previousStock !== null || m.newStock !== null
    ? `${m.previousStock === null ? '-' : m.previousStock} → ${m.newStock === null ? '-' : m.newStock}` : '';
  const held = m.reservedBefore !== m.reservedAfter ? ` · held ${m.reservedBefore} → ${m.reservedAfter}` : '';
  return `
    <div class="inv-move">
      <div><strong>${escapeHtml(MOVEMENT_LABELS[m.type] || m.type)}</strong> <span class="inv-move-qty">${sign}${m.quantity}</span>
        <span class="helper-text">${escapeHtml(m.productName)} - ${escapeHtml(m.label)}</span></div>
      <div class="helper-text">${escapeHtml(when)}${stock ? ' · stock ' + escapeHtml(stock) : ''}${held}${m.referenceId ? ' · ' + escapeHtml(m.referenceId) : ''}${m.notes ? ' · ' + escapeHtml(m.notes) : ''}</div>
    </div>`;
}
