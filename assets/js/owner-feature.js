// Paid featuring: choose products + days, then pay by bank transfer and upload
// the receipt. The checking itself is server-side (apps-script/Featuring.gs);
// the price shown here is a preview - the server computes the real amount,
// and decides whether this is the store's free first featuring.
document.addEventListener('DOMContentLoaded', init);

const PRICE_PER_PRODUCT_DAY = 0.05;
const MAX_DAYS = 60;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

let purchases = [];
let payment = { accountName: '', accountNumber: '' };
let freeAvailable = false;
let freeBlockedBecause = '';
let freeMaxProducts = 3;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  const statusEl = document.getElementById('feature-status');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listMyFeaturePurchases', { token: Auth.getToken() });
  stop();
  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }
  statusEl.textContent = ''; // the loading text stays until replaced
  purchases = res.purchases || [];
  payment = res.payment || payment;
  freeAvailable = !!res.freeAvailable;
  freeBlockedBecause = res.freeBlockedBecause || '';
  if (res.freeMaxProducts) freeMaxProducts = res.freeMaxProducts;
  renderHistory();

  const purchaseId = getQueryParam('purchase');
  if (purchaseId) {
    const p = purchases.find((x) => x.purchaseId === purchaseId);
    if (p) { showPayStep(p); return; }
    statusEl.textContent = 'That purchase could not be found.';
  }
  // ?renew= comes from the "ends tomorrow" email: same products and days, ready to pay.
  const renewFrom = purchases.find((x) => x.purchaseId === getQueryParam('renew'));
  await showSelectStep(renewFrom);
}

/* ---------- step 1: choose ---------- */

async function showSelectStep(preset) {
  const section = document.getElementById('feature-select');
  document.getElementById('feature-free-note').classList.toggle('hidden', !freeAvailable);
  // The free offer needs a phone number on the store (one free featuring per person).
  document.getElementById('feature-free-phone-note').classList.toggle('hidden', freeBlockedBecause !== 'nophone');
  const listEl = document.getElementById('feature-product-list');
  section.classList.remove('hidden');
  const res = await Api.post('listOwnerProducts', { token: Auth.getToken(), limit: 100 });
  const active = res.ok ? (res.products || []).filter((p) => p.status === 'active') : [];
  if (!res.ok) {
    listEl.innerHTML = '<p class="helper-text">Could not load your products. Please refresh.</p>';
  } else if (active.length === 0) {
    listEl.innerHTML = '<p class="helper-text">You have no active products yet. <a href="products.html">Add one first.</a></p>';
  } else {
    listEl.innerHTML = active.map((p) => `
      <label class="feature-product-option">
        <input type="checkbox" value="${escapeAttr(p.productId)}">
        <span>${escapeHtml(p.name)}</span>
      </label>`).join('');
  }
  if (preset) {
    const ticked = preset.productIds.filter((id) => {
      const box = listEl.querySelector(`input[value="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
      return !!box;
    });
    document.getElementById('feature-days').value = preset.days;
    if (ticked.length) {
      document.getElementById('feature-status').textContent = ticked.length < preset.productIds.length
        ? 'Renewing - some of those products are no longer active, so only the active ones are ticked.'
        : 'Renewing - the same products and days are ticked. Change them if you like.';
    }
  }
  section.addEventListener('change', updateTotal);
  document.getElementById('feature-days').addEventListener('input', updateTotal);
  document.getElementById('feature-continue-btn').addEventListener('click', onContinue);
  updateTotal();
}

function selectedProductIds() {
  return Array.from(document.querySelectorAll('#feature-product-list input:checked')).map((i) => i.value);
}

function selectedDays() {
  return parseInt(document.getElementById('feature-days').value, 10);
}

function isFreeChoice(n) {
  return freeAvailable && n >= 1 && n <= freeMaxProducts;
}

function updateTotal() {
  const n = selectedProductIds().length;
  const days = selectedDays();
  const out = document.getElementById('feature-total');
  const btn = document.getElementById('feature-continue-btn');
  btn.textContent = isFreeChoice(n) ? 'Feature for free' : 'Continue to payment';
  if (!n || !(days >= 1)) {
    out.textContent = 'Choose at least one product and a number of days.';
    return;
  }
  const what = `${n} product${n === 1 ? '' : 's'} × ${days} day${days === 1 ? '' : 's'}`;
  if (isFreeChoice(n)) {
    out.textContent = `${what} = Free (your first featuring)`;
    return;
  }
  const total = Math.round(n * days * PRICE_PER_PRODUCT_DAY * 100) / 100;
  out.textContent = `${what} × $0.05 = ${formatMoney(total)}`
    + (freeAvailable ? ` - choose ${freeMaxProducts} or fewer to feature them free` : '');
}

async function onContinue() {
  const errorEl = document.getElementById('feature-select-error');
  errorEl.textContent = '';
  const productIds = selectedProductIds();
  const days = selectedDays();
  if (productIds.length === 0) { errorEl.textContent = 'Choose at least one product.'; return; }
  if (!(days >= 1 && days <= MAX_DAYS)) { errorEl.textContent = `Choose between 1 and ${MAX_DAYS} days.`; return; }

  const btn = document.getElementById('feature-continue-btn');
  btn.disabled = true;
  const res = await Api.post('startFeaturePurchase', { token: Auth.getToken(), productIds, days });
  btn.disabled = false;
  if (!res.ok) { errorEl.textContent = res.error || 'Could not start this purchase. Please try again.'; return; }
  // Its own URL, so a refresh or a trip to the bank app and back lands on
  // the payment step with the same reference - never a second purchase.
  window.location.href = 'feature.html?purchase=' + encodeURIComponent(res.purchase.purchaseId);
}

/* ---------- step 2: pay + upload ---------- */

// The "?" beside the step 2 heading shows a drawn example of the receipt
// screen to screenshot. It shows where to pay, but deliberately not this
// purchase's reference or amount - so a screenshot of it is no use as a
// "receipt" (and it says EXAMPLE, which the server check rejects).
function setupExample() {
  const btn = document.getElementById('feature-example-btn');
  const fig = document.getElementById('feature-example');
  const values = { name: payment.accountName, number: payment.accountNumber };
  fig.querySelectorAll('[data-example]').forEach((el) => {
    const v = values[el.dataset.example];
    if (v) el.textContent = v;
  });
  btn.addEventListener('click', () => {
    const open = fig.hidden;
    fig.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
}

function isFreePurchase(p) {
  return Number(p.amount) === 0;
}

function showPayStep(p) {
  document.getElementById('feature-pay').classList.remove('hidden');
  if (isFreePurchase(p)) {
    // Nothing to pay: no bank details, no example, no upload.
    document.getElementById('feature-example-btn').classList.add('hidden');
    document.getElementById('feature-pay-title').textContent = 'Featured for free';
  } else {
    setupExample();
  }
  document.getElementById('feature-pay-summary').textContent =
    `${p.productNames.join(', ')} - ${p.days} day${p.days === 1 ? '' : 's'}.`;
  document.getElementById('pay-account-name').textContent = payment.accountName;
  document.getElementById('pay-account-number').textContent = payment.accountNumber;
  document.getElementById('pay-reference').textContent = p.reference;
  document.getElementById('pay-amount').textContent = formatMoney(p.amount);

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(document.getElementById(btn.dataset.copy).textContent, btn));
  });
  document.getElementById('feature-upload-btn').addEventListener('click', () => onUpload(p));

  if (p.status === 'Approved' || p.status === 'Pending review') {
    document.getElementById('feature-pay-steps').classList.add('hidden');
    showPayResult(p.status === 'Approved'
      ? (notStartedYet(p)
        ? `Paid - featuring starts ${fmtDateTime(p.startsAt)} and runs until ${fmtDate(p.endsAt)}.`
        : `${isFreePurchase(p) ? 'Free' : 'Paid'} - featured until ${fmtDate(p.endsAt)}.`)
      : 'Your payment is waiting for a quick check by Mwakete.', p.status);
  } else if (p.status === 'Rejected') {
    document.getElementById('feature-pay-error').textContent =
      'Your last screenshot could not be confirmed. Check the details above and upload the receipt again.';
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text.replace(/^\$/, ''));
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1500);
  } catch (e) { /* clipboard blocked - the value is on screen to type */ }
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function onUpload(p) {
  const errorEl = document.getElementById('feature-pay-error');
  errorEl.textContent = '';
  const file = document.getElementById('feature-screenshot').files[0];
  if (!file) { errorEl.textContent = 'Choose the screenshot of your payment receipt first.'; return; }
  if (file.size > MAX_UPLOAD_BYTES) { errorEl.textContent = 'That image is too large (max 5MB).'; return; }

  const btn = document.getElementById('feature-upload-btn');
  btn.disabled = true;
  btn.textContent = 'Checking payment…';
  let res;
  try {
    // Sent as-is, not compressed: OCR needs the receipt's text sharp, and the
    // duplicate-screenshot check needs the original file.
    res = await Api.post('submitFeaturePayment', {
      token: Auth.getToken(), purchaseId: p.purchaseId, imageBase64: await readAsBase64(file), mimeType: file.type
    });
  } catch (e) {
    res = { ok: false, error: 'That file could not be read. Please choose it again.' };
  }
  btn.disabled = false;
  btn.textContent = 'Upload payment screenshot';
  if (!res.ok) { errorEl.textContent = res.error || 'Upload failed. Please try again.'; return; }

  const updated = res.purchase;
  const idx = purchases.findIndex((x) => x.purchaseId === updated.purchaseId);
  if (idx !== -1) purchases[idx] = Object.assign({}, purchases[idx], updated);
  renderHistory();
  if (updated.status === 'Rejected') {
    errorEl.textContent = res.message;
    return;
  }
  document.getElementById('feature-pay-steps').classList.add('hidden');
  showPayResult(res.message, updated.status);
}

function showPayResult(text, status) {
  const el = document.getElementById('feature-pay-result');
  el.textContent = text;
  el.className = 'feature-pay-result' + (status === 'Approved' ? ' is-approved' : ' is-pending');
}

/* ---------- history ---------- */

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
}

// Automatic approvals start a couple of hours later (Featuring.gs, FEATURE_START_DELAY_HOURS).
function notStartedYet(p) {
  return p.status === 'Approved' && !!p.startsAt && new Date(p.startsAt).getTime() > Date.now();
}

function statusLine(p) {
  if (notStartedYet(p)) return `Paid - starts ${fmtDateTime(p.startsAt)}`;
  if (p.status === 'Approved') {
    const live = new Date(p.endsAt).getTime() > Date.now();
    return live ? `Featured until ${fmtDate(p.endsAt)}` : `Ended ${fmtDate(p.endsAt)}`;
  }
  return p.status;
}

// Views each product picked up while featured (Featuring.gs featureViewsGained).
function resultsHtml(p) {
  if (p.status !== 'Approved' || !p.viewsGained) return '';
  const ids = Object.keys(p.viewsGained);
  if (ids.length === 0) return '';
  const total = ids.reduce((sum, id) => sum + p.viewsGained[id], 0);
  const live = new Date(p.endsAt).getTime() > Date.now();
  const each = ids.map((id) => {
    const i = p.productIds.indexOf(id);
    const name = i !== -1 ? p.productNames[i] : id;
    return `${escapeHtml(name)} +${p.viewsGained[id]}`;
  }).join(' · ');
  return `<div class="feature-results"><strong>+${total} view${total === 1 ? '' : 's'}</strong> ${live ? 'so far while featured' : 'while featured'}<span class="helper-text"> (${each})</span></div>`;
}

function renderHistory() {
  const el = document.getElementById('feature-history');
  if (purchases.length === 0) {
    el.innerHTML = '<p class="helper-text">Nothing featured yet.</p>';
    return;
  }
  el.innerHTML = purchases.map((p) => {
    const payable = p.status === 'Awaiting payment' || p.status === 'Rejected';
    return `
      <div class="feature-history-row">
        <div>
          <strong>${escapeHtml(p.productNames.join(', '))}</strong>
          <div class="helper-text">${p.days} day${p.days === 1 ? '' : 's'} · ${isFreePurchase(p) ? 'Free' : formatMoney(p.amount)} · ref ${escapeHtml(p.reference)}</div>
          ${resultsHtml(p)}
        </div>
        <div class="feature-history-status">
          <span>${escapeHtml(statusLine(p))}</span>
          ${payable ? `<a class="btn btn-small btn-primary" href="feature.html?purchase=${encodeURIComponent(p.purchaseId)}">Pay now</a>` : ''}
        </div>
      </div>`;
  }).join('');
}
