// Point of Sale (owner/pos.html): search or scan, build a cart, take cash or
// RECORD a card / mobile payment, print a receipt, refund, and read reports.
// The browser only sends item ids and quantities. Prices, discounts, change,
// totals and stock are all worked out by the server (apps-script/Pos.gs); a
// price sent from here is ignored. The sale reference (clientTxnId) is made
// once per cart and reused on retry, so a double tap or a bad connection never
// sells twice. Sales need a connection: nothing is queued on the device.
document.addEventListener('DOMContentLoaded', init);

let owner = null;
let settings = { maxDiscountPct: 10 };
let cart = [];            // { variantId, name, label, price, available, qty }
let txnId = '';
let busy = false;
let lastReceipt = null;

const $ = (id) => document.getElementById(id);
const call = (action, payload) => Api.post(action, Object.assign({ token: Auth.getToken() }, payload || {}));
const money = (n) => formatMoney(n);
const newTxn = () => 'pos-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setStatus = (m) => { $('pos-status').textContent = m || ''; };

async function init() {
  owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  $('store-name-label').textContent = shortStoreName(owner.storeName);
  const res = await call('posGetSettings');
  if (!res.ok) { show('pos-off', true); if (res.error && !/not switched on/i.test(res.error)) setStatus(res.error); return; }
  settings = res.settings;
  show('pos-main', true);
  fillSettings();
  txnId = newTxn();
  document.querySelectorAll('.pos-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('pos-q').addEventListener('input', debounce(search, 200));
  $('pos-q').addEventListener('keydown', onScanKey);
  $('pos-disc').addEventListener('input', renderCart);
  $('pos-disc-type').addEventListener('change', renderCart);
  $('pos-tender').addEventListener('input', renderCart);
  document.querySelectorAll('input[name="pay"]').forEach((r) => r.addEventListener('change', renderCart));
  $('pos-charge').addEventListener('click', charge);
  $('pos-clear').addEventListener('click', clearCart);
  $('receipt-print').addEventListener('click', () => window.print());
  $('receipt-close').addEventListener('click', () => { show('receipt-modal', false); $('pos-q').focus(); });
  $('sales-go').addEventListener('click', loadSales);
  $('rep-go').addEventListener('click', loadReport);
  $('st-save').addEventListener('click', saveSettings);
  const today = new Date().toISOString().slice(0, 10);
  $('rep-from').value = today; $('rep-to').value = today;
  window.addEventListener('online', syncOnline); window.addEventListener('offline', syncOnline);
  syncOnline();
  renderCart();
}

function syncOnline() { show('pos-offline', !navigator.onLine); renderCart(); }
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

function switchTab(name) {
  document.querySelectorAll('.pos-tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  ['sell', 'sales', 'report', 'settings'].forEach((t) => show('tab-' + t, t === name));
  if (name === 'sales') loadSales();
  if (name === 'report') loadReport();
}

/* ---------- find items ---------- */
let lastResults = [];
async function search() {
  const q = $('pos-q').value.trim();
  if (!q) { $('pos-results').innerHTML = ''; lastResults = []; return; }
  const res = await call('posSearch', { q });
  if (!res.ok) { $('pos-results').innerHTML = `<p class="form-error">${escapeHtml(res.error || 'Search failed.')}</p>`; return; }
  lastResults = res.items || [];
  $('pos-results').innerHTML = lastResults.length ? lastResults.map((i, n) => `<button type="button" class="pos-item" data-n="${n}" ${i.available < 1 ? 'disabled' : ''}>
      <strong>${escapeHtml(i.name)}</strong> <span>${escapeHtml(i.label || '')}</span><br><span class="helper-text">${money(i.price)} · ${i.available < 1 ? 'none to sell' : i.available + ' available'}${i.sku ? ' · ' + escapeHtml(i.sku) : ''}</span></button>`).join('') : '<p class="helper-text">No match.</p>';
  $('pos-results').querySelectorAll('.pos-item').forEach((b) => b.addEventListener('click', () => addItem(lastResults[Number(b.dataset.n)])));
  return res;
}
async function onScanKey(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const res = await search();
  // A scanner types the code then Enter: an exact barcode / SKU hit goes straight into the cart.
  if (res && res.exact && lastResults.length && lastResults[0].available > 0) { addItem(lastResults[0]); }
  else if (res && lastResults.length === 0) setStatus('Nothing found for that code.');
}
function addItem(i) {
  if (!i) return;
  const line = cart.find((l) => l.variantId === i.variantId);
  if (line) { if (line.qty < i.available) line.qty++; else setStatus('That is all that is available.'); }
  else cart.push({ variantId: i.variantId, name: i.name, label: i.label, price: i.price, available: i.available, qty: 1 });
  $('pos-q').value = ''; $('pos-results').innerHTML = ''; $('pos-q').focus();
  setStatus(''); renderCart();
}

/* ---------- cart (a preview only: the server decides the real numbers) ---------- */
function totals() {
  const subtotal = cart.reduce((n, l) => n + l.qty * l.price, 0);
  const v = Number($('pos-disc').value) || 0;
  const type = $('pos-disc-type').value;
  let discount = v > 0 ? (type === 'percent' ? subtotal * v / 100 : v) : 0;
  const cap = subtotal * (Number(settings.maxDiscountPct) || 0) / 100;
  return { subtotal, discount: Math.round(discount * 100) / 100, total: Math.round((subtotal - discount) * 100) / 100, overCap: discount > cap + 0.005, whole: discount >= subtotal && subtotal > 0 };
}
function renderCart() {
  const box = $('pos-lines');
  if (!cart.length) box.innerHTML = '<p class="helper-text">Nothing added yet.</p>';
  else {
    box.innerHTML = cart.map((l, n) => `<div class="pos-line" data-n="${n}"><div><strong>${escapeHtml(l.name)}</strong> <span>${escapeHtml(l.label || '')}</span><br><span class="helper-text">${money(l.price)} each</span></div>
      <div class="pos-qty"><button type="button" class="btn btn-small" data-d="-1" aria-label="One less">−</button><span aria-live="polite">${l.qty}</span><button type="button" class="btn btn-small" data-d="1" aria-label="One more">+</button></div>
      <div class="pos-line-total">${money(l.qty * l.price)}</div></div>`).join('');
    box.querySelectorAll('.pos-line').forEach((row) => row.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
      const l = cart[Number(row.dataset.n)];
      l.qty += Number(b.dataset.d);
      if (l.qty > l.available) { l.qty = l.available; setStatus('That is all that is available.'); }
      if (l.qty < 1) cart.splice(Number(row.dataset.n), 1);
      renderCart();
    })));
  }
  const t = totals();
  $('pos-total').textContent = money(t.total);
  const pay = document.querySelector('input[name="pay"]:checked').value;
  show('pay-cash', pay === 'cash'); show('pay-digital', pay !== 'cash');
  const tender = $('pos-tender').value === '' ? t.total : Number($('pos-tender').value);
  $('pos-change').textContent = pay === 'cash' && cart.length ? (tender + 0.005 < t.total ? 'Not enough: ' + money(t.total - tender) + ' short' : 'Change: ' + money(tender - t.total)) : '';
  $('pos-disc-hint').textContent = t.overCap ? `More than the ${settings.maxDiscountPct}% allowed. Change this in Settings.` : (t.whole ? 'A discount cannot be the whole sale.' : '');
  $('pos-charge').disabled = !cart.length || busy || !navigator.onLine || t.overCap || t.whole || (pay === 'cash' && tender + 0.005 < t.total);
  $('pos-charge').textContent = cart.length ? 'Complete sale — ' + money(t.total) : 'Complete sale';
}
function clearCart() { cart = []; $('pos-disc').value = ''; $('pos-tender').value = ''; $('pos-ref').value = ''; $('pos-error').textContent = ''; txnId = newTxn(); renderCart(); $('pos-q').focus(); }

async function charge() {
  if (busy || !cart.length) return;
  busy = true; renderCart(); $('pos-error').textContent = '';
  const pay = document.querySelector('input[name="pay"]:checked').value;
  const payment = { method: pay };
  if (pay === 'cash' && $('pos-tender').value !== '') payment.amountTendered = Number($('pos-tender').value);
  if (pay !== 'cash') payment.reference = $('pos-ref').value.trim();
  const body = { clientTxnId: txnId, lines: cart.map((l) => ({ variantId: l.variantId, qty: l.qty })), payment };
  const d = Number($('pos-disc').value) || 0;
  if (d > 0) body.discount = { type: $('pos-disc-type').value, value: d };
  const res = await call('posCheckout', body);
  busy = false;
  if (!res.ok) { $('pos-error').textContent = res.error || 'The sale did not go through. Nothing was taken. Check your connection and try again.'; renderCart(); return; }
  // Success: same txnId is only reused on failure, never after a sale.
  showReceipt(res.receipt);
  clearCart();
}

function receiptHtml(r) {
  const tax = r.tax > 0 ? `<tr><td colspan="2">Includes tax (${r.taxPercent}%)</td><td>${money(r.tax)}</td></tr>` : '';
  return `<div class="pos-receipt"><h2 id="receipt-title">${escapeHtml(r.store.name)}</h2>
    <p class="helper-text">${escapeHtml([r.store.village, r.store.island].filter(Boolean).join(', '))}${r.store.phone ? ' · ' + escapeHtml(r.store.phone) : ''}<br>Receipt ${escapeHtml(r.receiptNo)} · ${escapeHtml(new Date(r.createdAt).toLocaleString())}</p>
    <table class="pos-receipt-table"><tbody>${r.lines.map((l) => `<tr><td>${escapeHtml(l.name)} ${escapeHtml(l.label || '')}<br><small>${l.qty} × ${money(l.unitPrice)}</small></td><td></td><td>${money(l.lineTotal + (l.lineDiscount || 0))}</td></tr>`).join('')}
    ${r.discount > 0 ? `<tr><td colspan="2">Discount</td><td>−${money(r.discount)}</td></tr>` : ''}${tax}
    <tr class="pos-receipt-total"><td colspan="2"><strong>Total</strong></td><td><strong>${money(r.total)}</strong></td></tr></tbody></table>
    <p>${escapeHtml(r.payment.label || '')}${r.payment.method === 'cash' && r.payment.tendered != null ? ` · given ${money(r.payment.tendered)}, change ${money(r.payment.change)}` : ''}</p>
    ${r.returnPolicy ? `<p class="helper-text">${escapeHtml(r.returnPolicy)}</p>` : ''}${r.footer ? `<p>${escapeHtml(r.footer)}</p>` : ''}</div>`;
}
function showReceipt(r) { lastReceipt = r; $('receipt-body').innerHTML = receiptHtml(r); show('receipt-modal', true); $('receipt-print').focus(); }

/* ---------- sales and refunds ---------- */
async function loadSales() {
  const res = await call('posListSales', { q: $('sales-q').value.trim(), limit: 50 });
  const box = $('sales-list');
  if (!res.ok) { box.innerHTML = `<p class="form-error">${escapeHtml(res.error || 'Could not load.')}</p>`; return; }
  if (!res.sales.length) { box.innerHTML = '<p class="helper-text">No sales yet.</p>'; return; }
  box.innerHTML = `<div class="hub-table-wrap"><table class="hub-table"><thead><tr><th>Receipt</th><th>When</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${res.sales.map((s) => `<tr data-id="${escapeAttr(s.saleId)}">
    <td>${escapeHtml(s.receiptNo)}</td><td>${escapeHtml(new Date(s.createdAt).toLocaleString())}</td><td>${money(s.total)}${s.refunded ? '<br><small>refunded ' + money(s.refunded) + '</small>' : ''}</td>
    <td>${escapeHtml(s.status.replace('_', ' '))}</td><td><button type="button" class="btn btn-small">Open</button></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => openSale(b.closest('tr').dataset.id)));
}
async function openSale(saleId) {
  const res = await call('posGetSale', { saleId });
  const box = $('sale-detail');
  if (!res.ok) { box.innerHTML = `<p class="form-error">${escapeHtml(res.error || 'Not found.')}</p>`; show('sale-detail', true); return; }
  const s = res.sale;
  const refundable = s.lines.filter((l) => l.qty - l.refundedQty > 0);
  box.innerHTML = `<h3>${escapeHtml(s.receiptNo)}</h3>${receiptHtml(res.receipt)}
    ${s.refunds.length ? '<h4>Refunds recorded</h4>' + s.refunds.map((r) => `<p>${money(r.amount)} — ${escapeHtml(r.reason)} <small>${escapeHtml(new Date(r.createdAt).toLocaleString())}</small></p>`).join('') : ''}
    ${refundable.length ? `<h4>Refund</h4><p class="helper-text">Mwakete does not move money. Give the customer the amount yourself; this records it and, if you tick the box, puts the goods back in stock.</p>
      ${refundable.map((l) => `<div class="pos-refund-row" data-line="${escapeAttr(l.lineId)}"><span>${escapeHtml(l.name)} ${escapeHtml(l.label || '')}</span>
        <input type="number" min="0" max="${l.qty - l.refundedQty}" value="0" aria-label="Quantity to refund"> <label class="check"><input type="checkbox"> goods back in stock</label></div>`).join('')}
      <div class="field"><label for="rf-reason">Why?</label><input type="text" id="rf-reason" maxlength="120" placeholder="Wrong size"></div>
      <p id="rf-error" class="form-error" role="alert"></p><button type="button" class="btn btn-primary" id="rf-go">Record refund</button>` : '<p class="helper-text">Nothing left to refund.</p>'}
    <p><button type="button" class="btn" id="sd-print">Print receipt</button> <button type="button" class="btn" id="sd-close">Close</button></p>`;
  show('sale-detail', true);
  $('sd-close').addEventListener('click', () => show('sale-detail', false));
  $('sd-print').addEventListener('click', () => { lastReceipt = res.receipt; $('receipt-body').innerHTML = receiptHtml(res.receipt); show('receipt-modal', true); });
  const go = $('rf-go');
  if (go) {
    let reqId = 'rf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    go.addEventListener('click', async () => {
      const lines = [];
      box.querySelectorAll('.pos-refund-row').forEach((row) => { const q = Number(row.querySelector('input[type=number]').value); if (q > 0) lines.push({ lineId: row.dataset.line, qty: q, restock: row.querySelector('input[type=checkbox]').checked }); });
      if (!lines.length) { $('rf-error').textContent = 'Enter how many to refund.'; return; }
      go.disabled = true;
      const r = await call('posRefundSale', { saleId, requestId: reqId, reason: $('rf-reason').value, lines });
      go.disabled = false;
      if (!r.ok) { $('rf-error').textContent = r.error || 'Could not record it.'; return; }
      setStatus(r.note || 'Refund recorded.');
      loadSales(); openSale(saleId);
    });
  }
}

/* ---------- reports ---------- */
async function loadReport() {
  const res = await call('posReport', { from: $('rep-from').value, to: $('rep-to').value });
  const box = $('rep-body');
  if (!res.ok) { box.innerHTML = `<p class="form-error">${escapeHtml(res.error || 'Could not load.')}</p>`; return; }
  const c = res.channels;
  const row = (label, x, extra) => `<tr><td>${label}${extra ? '<br><small>' + escapeHtml(extra) + '</small>' : ''}</td><td>${money(x.gross)}</td><td>${money(x.refunds)}</td><td><strong>${money(x.net)}</strong></td></tr>`;
  box.innerHTML = `<div class="hub-table-wrap"><table class="hub-table"><thead><tr><th>Where</th><th>Sold</th><th>Refunded</th><th>Net</th></tr></thead><tbody>
    ${row('In-store (this till)', c.pos, c.pos.sales + ' sales')}${row('Online store', c.online, c.online.note)}${row('Connected systems', c.connected, c.connected.note)}
    <tr class="pos-receipt-total"><td>All together</td><td>${money(res.combined.gross)}</td><td>${money(res.combined.refunds)}</td><td><strong>${money(res.combined.net)}</strong></td></tr></tbody></table></div>
    <h3>Payments (this till)</h3>${res.payments.length ? '<ul>' + res.payments.map((p) => `<li>${escapeHtml(p.method)} — ${p.count} sale${p.count === 1 ? '' : 's'}, ${money(p.amount)} <small>(${escapeHtml(p.label)})</small></li>`).join('') + '</ul>' : '<p class="helper-text">None.</p>'}
    <h3>Profit</h3><p>${res.profit.available ? money(res.profit.estimated) : 'Not shown'} <small class="helper-text">${escapeHtml(res.profit.note)}</small></p>
    <h3>Low stock</h3>${res.lowStock.length ? '<ul>' + res.lowStock.map((l) => `<li>${escapeHtml(l.name)} ${escapeHtml(l.label || '')} — ${l.available} left</li>`).join('') + '</ul>' : '<p class="helper-text">Nothing is low.</p>'}`;
}

/* ---------- settings ---------- */
function fillSettings() {
  $('st-disc').value = settings.maxDiscountPct; $('st-tax').value = settings.taxPercent || 0;
  $('st-policy').value = settings.returnPolicy || ''; $('st-footer').value = settings.receiptFooter || '';
}
async function saveSettings() {
  $('st-error').textContent = '';
  const res = await call('posSaveSettings', { maxDiscountPct: $('st-disc').value, taxPercent: $('st-tax').value, returnPolicy: $('st-policy').value, receiptFooter: $('st-footer').value });
  if (!res.ok) { $('st-error').textContent = res.error || 'Could not save.'; return; }
  settings = res.settings; setStatus('Saved.'); renderCart();
}
