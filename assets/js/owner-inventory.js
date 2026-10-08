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
let caps = {};
let locations = [];   // [{locationId, name, type, isMain, units, ...}] for wholesalers / distributors
let suppliers = [];

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
  caps = res.capabilities || {};
  renderSummary(res.summary);
  renderMore(caps);
  renderList();
  if (caps.locations) loadLocations(false);
  if (caps.suppliers) loadSuppliers(false);
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
function renderMore(c) {
  const links = [];
  if (c.sync) links.push('<a class="btn btn-small inv-tool-btn" href="inventory-sync.html">Import / Sync</a>');
  if (c.locations) links.push('<button type="button" class="btn btn-small inv-tool-btn" data-tool="locations">Locations</button>');
  if (c.suppliers) links.push('<button type="button" class="btn btn-small inv-tool-btn" data-tool="suppliers">Suppliers</button>');
  if (c.reports) links.push('<button type="button" class="btn btn-small inv-tool-btn" data-tool="reports">Reports</button>');
  const el = document.getElementById('inv-more');
  el.innerHTML = links.join(' ');
  el.classList.toggle('hidden', links.length === 0);
  el.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => openTool(b.dataset.tool)));
}

function openTool(name) {
  const section = document.getElementById('inv-tool-' + name);
  const opening = section.classList.contains('hidden');
  document.querySelectorAll('.inv-tool').forEach((t) => t.classList.add('hidden'));
  if (!opening) return;
  section.classList.remove('hidden');
  if (name === 'locations') loadLocations(true);
  if (name === 'suppliers') loadSuppliers(true);
  if (name === 'reports') loadReport();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          ${i.locations ? `<div class="inv-split helper-text">${i.locations.map((l) => `${escapeHtml(l.name)} <strong>${l.qty}</strong>`).join(' · ')}</div>` : ''}
          ${i.health === 'low' ? `<div class="inv-hint">Low: at or below your level of ${i.reorderLevel}.${i.reorderQty ? ' You usually reorder ' + i.reorderQty + '.' : ''}</div>` : ''}
        </div>
        <div class="inv-row-actions">
          <button type="button" class="btn btn-small btn-primary" data-act="receive">Receive</button>
          <button type="button" class="btn btn-small" data-act="adjust">Adjust</button>
          ${caps.transfers && i.tracked ? '<button type="button" class="btn btn-small" data-act="transfer">Transfer</button>' : ''}
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
    { receive: 'Receive stock', adjust: 'Adjust stock', settings: 'Stock settings', transfer: 'Move stock' }[kind] + ': ' + item.productName + ' - ' + item.label;
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
      ${locationField('inv-loc', 'Received at', item)}
      ${field('inv-supplier', 'Supplier (optional)', `<input id="inv-supplier" type="text" maxlength="100" autocomplete="organization" list="inv-supplier-list">
        <datalist id="inv-supplier-list">${suppliers.map((x) => `<option value="${escapeAttr(x.name)}">`).join('')}</datalist>`)}
      ${field('inv-invoice', 'Invoice / reference (optional)', `<input id="inv-invoice" type="text" maxlength="60">`)}
      ${field('inv-cost', 'Cost per unit (optional)', `<input id="inv-cost" type="number" inputmode="decimal" min="0" step="0.01" value="${item.costPrice == null ? '' : item.costPrice}">`)}
      ${buttons('Add to stock')}`;
  } else if (kind === 'adjust') {
    form.innerHTML = `
      ${locationField('inv-loc', 'Where?', item)}
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
  } else if (kind === 'transfer') {
    const opts = (item.locations || []).map((l) => `<option value="${escapeAttr(l.locationId)}">${escapeHtml(l.name)} (${l.qty})</option>`).join('');
    form.innerHTML = `
      ${field('inv-from', 'From', `<select id="inv-from">${opts}</select>`)}
      ${field('inv-to', 'To', `<select id="inv-to">${opts}</select>`)}
      ${field('inv-qty', 'How many units', `<input id="inv-qty" type="number" inputmode="numeric" min="1" step="1">`)}
      ${field('inv-notes', 'Note (optional)', `<input id="inv-notes" type="text" maxlength="200">`)}
      ${buttons('Move stock')}`;
    const to = form.querySelector('#inv-to');
    if (to.options.length > 1) to.selectedIndex = 1;
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

// Only shown when the store has more than one place.
function locationField(id, label, item) {
  if (!item.locations || item.locations.length < 2) return '';
  return field(id, label, `<select id="${id}">${item.locations.map((l) => `<option value="${escapeAttr(l.locationId)}">${escapeHtml(l.name)} (now ${l.qty})</option>`).join('')}</select>`);
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
    payload = { quantity: val('inv-qty'), supplier: val('inv-supplier'), invoice: val('inv-invoice'), unitCost: val('inv-cost'), locationId: val('inv-loc') };
  } else if (kind === 'adjust') {
    const reason = val('inv-reason');
    action = 'adjustStock';
    payload = { reason, newCount: val('inv-count'), quantity: val('inv-qty'), notes: val('inv-notes'), locationId: val('inv-loc') };
  } else if (kind === 'transfer') {
    if (!(Number(val('inv-qty')) > 0)) { errEl.textContent = 'Enter how many units to move.'; return; }
    action = 'transferStock';
    payload = { fromLocationId: val('inv-from'), toLocationId: val('inv-to'), quantity: val('inv-qty'), notes: val('inv-notes') };
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
  if (res.item) {
    const idx = items.findIndex((i) => i.variantId === res.item.variantId);
    // Keep the location split until the list reloads below.
    if (idx !== -1) items[idx] = Object.assign({}, res.item, items[idx].locations ? { locations: items[idx].locations } : {});
  }
  if (caps.locations && items.some((i) => i.locations)) await reloadItemsQuietly();
  renderList();
  savedEl.textContent = kind === 'transfer'
    ? 'Moved. ' + (res.locations || []).map((l) => `${l.name} ${l.qty}`).join(' · ')
    : 'Saved. ' + (res.item && res.item.tracked ? `${res.item.physical} in stock, ${res.item.available} available.` : '');
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
      <div class="helper-text">${escapeHtml(when)}${stock ? (m.type === 'STOCK_TRANSFER' ? ' · at that location ' : ' · stock ') + escapeHtml(stock) : ''}${held}${m.referenceId ? ' · ' + escapeHtml(m.referenceId) : ''}${m.notes ? ' · ' + escapeHtml(m.notes) : ''}</div>
    </div>`;
}

// After a change at one location, the split for every place comes from the server.
async function reloadItemsQuietly() {
  const res = await Api.post('getInventory', { token: Auth.getToken() });
  if (res.ok) { items = res.items || []; caps = res.capabilities || caps; }
}

/* ---------- locations ---------- */

async function loadLocations(render) {
  const res = await Api.post('listLocations', { token: Auth.getToken() });
  if (!res.ok) return;
  locations = res.locations || [];
  if (render !== false) renderLocations();
}

function renderLocations() {
  const el = document.getElementById('inv-locations');
  const form = document.getElementById('inv-location-form');
  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', (e) => { e.preventDefault(); saveLocation({ name: document.getElementById('inv-loc-name').value, type: document.getElementById('inv-loc-type').value }); });
    el.addEventListener('click', onLocationClick);
  }
  el.innerHTML = locations.map((l) => `
    <div class="inv-move" data-loc="${escapeAttr(l.locationId)}">
      <strong>${escapeHtml(l.name)}</strong> <span class="helper-text">${l.isMain ? 'Main location' : escapeHtml(l.type)}</span>
      <div class="helper-text">${l.units} unit${l.units === 1 ? '' : 's'} across ${l.items} item${l.items === 1 ? '' : 's'}${l.value ? ' · ' + formatMoney(l.value) + ' at cost' : ''}</div>
      <div class="inv-row-actions">
        <button type="button" class="btn btn-small" data-loc-act="rename">Rename</button>
        ${l.isMain ? '' : '<button type="button" class="btn btn-small" data-loc-act="close">Close</button>'}
      </div>
    </div>`).join('');
}

async function saveLocation(body) {
  const errEl = document.getElementById('inv-locations-error');
  errEl.textContent = '';
  const res = await Api.post('saveLocation', Object.assign({ token: Auth.getToken() }, body));
  if (!res.ok) { errEl.textContent = res.error || 'Could not save the location.'; return; }
  document.getElementById('inv-loc-name').value = '';
  await loadLocations(true);
  await loadInventory();
}

async function onLocationClick(e) {
  const btn = e.target.closest('[data-loc-act]');
  if (!btn) return;
  const loc = locations.find((l) => l.locationId === btn.closest('[data-loc]').dataset.loc);
  const errEl = document.getElementById('inv-locations-error');
  errEl.textContent = '';
  if (btn.dataset.locAct === 'rename') {
    const name = window.prompt('New name for ' + loc.name, loc.name);
    if (name && name.trim() !== loc.name) saveLocation({ locationId: loc.locationId, name: name.trim(), type: loc.type });
    return;
  }
  if (!window.confirm('Close ' + loc.name + '? It must be empty first.')) return;
  const res = await Api.post('archiveLocation', { token: Auth.getToken(), locationId: loc.locationId });
  if (!res.ok) { errEl.textContent = res.error; return; }
  await loadLocations(true);
  await loadInventory();
}

/* ---------- suppliers ---------- */

async function loadSuppliers(render) {
  const res = await Api.post('listSuppliers', { token: Auth.getToken() });
  if (!res.ok) return;
  suppliers = res.suppliers || [];
  if (render !== false) renderSuppliers();
}

function renderSuppliers() {
  const el = document.getElementById('inv-suppliers');
  const form = document.getElementById('inv-supplier-form');
  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', (e) => { e.preventDefault(); saveSupplier(); });
    el.addEventListener('click', onSupplierClick);
  }
  el.innerHTML = suppliers.length ? suppliers.map((x) => `
    <div class="inv-move" data-sup="${escapeAttr(x.supplierId)}">
      <strong>${escapeHtml(x.name)}</strong>
      <div class="helper-text">${[x.phone, x.email].filter(Boolean).map(escapeHtml).join(' · ') || 'No contact details'}</div>
      <div class="inv-row-actions">
        <button type="button" class="btn btn-small" data-sup-act="edit">Edit</button>
        <button type="button" class="btn btn-small" data-sup-act="remove">Remove</button>
      </div>
    </div>`).join('') : '<p class="helper-text">No suppliers yet. Add the businesses you buy stock from - they appear when you receive stock.</p>';
}

async function saveSupplier() {
  const errEl = document.getElementById('inv-suppliers-error');
  errEl.textContent = '';
  const g = (id) => document.getElementById(id).value.trim();
  const res = await Api.post('saveSupplier', { token: Auth.getToken(), supplierId: g('inv-sup-id'), name: g('inv-sup-name'), phone: g('inv-sup-phone'), email: g('inv-sup-email') });
  if (!res.ok) { errEl.textContent = res.error || 'Could not save the supplier.'; return; }
  ['inv-sup-id', 'inv-sup-name', 'inv-sup-phone', 'inv-sup-email'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('inv-sup-save').textContent = 'Add supplier';
  await loadSuppliers(true);
}

async function onSupplierClick(e) {
  const btn = e.target.closest('[data-sup-act]');
  if (!btn) return;
  const sup = suppliers.find((x) => x.supplierId === btn.closest('[data-sup]').dataset.sup);
  if (btn.dataset.supAct === 'edit') {
    document.getElementById('inv-sup-id').value = sup.supplierId;
    document.getElementById('inv-sup-name').value = sup.name;
    document.getElementById('inv-sup-phone').value = sup.phone;
    document.getElementById('inv-sup-email').value = sup.email;
    document.getElementById('inv-sup-save').textContent = 'Save supplier';
    document.getElementById('inv-sup-name').focus();
    return;
  }
  if (!window.confirm('Remove ' + sup.name + '? Past stock received from them keeps their name.')) return;
  const res = await Api.post('archiveSupplier', { token: Auth.getToken(), supplierId: sup.supplierId });
  if (!res.ok) { document.getElementById('inv-suppliers-error').textContent = res.error; return; }
  await loadSuppliers(true);
}

/* ---------- reports ---------- */

async function loadReport() {
  const el = document.getElementById('inv-report');
  const sel = document.getElementById('inv-report-days');
  if (!sel.dataset.bound) { sel.dataset.bound = '1'; sel.addEventListener('change', loadReport); }
  el.innerHTML = '<p class="helper-text">Loading…</p>';
  const res = await Api.post('inventoryReport', { token: Auth.getToken(), days: sel.value });
  if (!res.ok) { el.innerHTML = '<p class="helper-text">Could not load the report.</p>'; return; }
  const r = res.report;
  const tile = (n, label) => `<div class="inv-tile"><span class="inv-tile-value">${n}</span><span class="inv-tile-label">${label}</span></div>`;
  const list = (title, rows) => rows.length ? `<h3>${title}</h3><ul class="inv-report-list">${rows.join('')}</ul>` : '';
  el.innerHTML = `<div class="inv-summary">${tile(r.received, 'units received')}${tile(r.sold, 'units sold')}${tile(r.damaged, 'damaged / expired')}${tile(r.returned, 'returned')}</div>` +
    list('Best sellers', r.topSellers.map((t) => `<li>${escapeHtml(t.name)} <strong>${t.units}</strong></li>`)) +
    list('Received by supplier', r.bySupplier.map((x) => `<li>${escapeHtml(x.supplier)} <strong>${x.units}</strong></li>`)) +
    list('Stock by location', (r.byLocation || []).map((l) => `<li>${escapeHtml(l.name)} <strong>${l.units}</strong>${l.value ? ' · ' + formatMoney(l.value) : ''}</li>`));
}
