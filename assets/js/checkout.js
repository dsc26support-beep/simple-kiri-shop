document.addEventListener('DOMContentLoaded', init);

let currentSlug = null;
let storeInfo = null;

async function init() {
  currentSlug = localStorage.getItem('skiri_active_store');
  const errorEl = document.getElementById('checkout-error');

  if (!currentSlug || Cart.getCart(currentSlug).length === 0) {
    window.location.href = 'cart.html';
    return;
  }

  document.getElementById('back-to-cart-link').href = 'cart.html';

  const res = await Api.get('getStorePublicInfo', { storeSlug: currentSlug });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not load this store.';
    document.getElementById('place-order-btn').disabled = true;
    return;
  }
  storeInfo = res.store;
  document.getElementById('store-name-tagline').textContent = `Checkout — ${storeInfo.storeName}`;

  renderPaymentPanels();
  renderOrderReview();

  document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
    radio.addEventListener('change', updatePaymentPanelVisibility);
  });

  document.getElementById('checkout-form').addEventListener('submit', onSubmit);
  document.getElementById('copy-summary-btn').addEventListener('click', onCopySummary);
}

function renderPaymentPanels() {
  document.getElementById('payment-instructions-anz').innerHTML = `
    <dl>
      <dt>Account Name</dt><dd>${escapeHtml(storeInfo.anzAccountName || 'Not provided yet — please contact the store')}</dd>
      <dt>Account Number</dt><dd>${escapeHtml(storeInfo.anzAccountNumber || '—')}</dd>
      <dt>Branch</dt><dd>${escapeHtml(storeInfo.anzBranch || '—')}</dd>
    </dl>
    <p class="helper-text">Use your Order Reference as the transfer reference.</p>
  `;
  document.getElementById('payment-instructions-teremo').innerHTML = `
    <dl>
      <dt>Teremo Number</dt><dd>${escapeHtml(storeInfo.teremoNumber || 'Not provided yet — please contact the store')}</dd>
      <dt>Registered Name</dt><dd>${escapeHtml(storeInfo.teremoName || '—')}</dd>
    </dl>
    <p class="helper-text">Include your Order Reference in the transfer note.</p>
  `;
  if (storeInfo.paymentNotes) {
    document.getElementById('payment-instructions-anz').innerHTML += `<p>${escapeHtml(storeInfo.paymentNotes)}</p>`;
    document.getElementById('payment-instructions-teremo').innerHTML += `<p>${escapeHtml(storeInfo.paymentNotes)}</p>`;
  }
}

function updatePaymentPanelVisibility() {
  const method = document.querySelector('input[name="paymentMethod"]:checked')?.value;
  document.getElementById('payment-instructions-anz').classList.toggle('hidden', method !== 'ANZ');
  document.getElementById('payment-instructions-teremo').classList.toggle('hidden', method !== 'Teremo');
}

function renderOrderReview() {
  const cart = Cart.getCart(currentSlug);
  document.getElementById('order-review').innerHTML = cart
    .map(
      (line) => `
      <div class="cart-line">
        <div class="cart-line-info">${line.qty} × ${escapeHtml(line.label)}</div>
        <strong>${formatMoney(line.unitPrice * line.qty)}</strong>
      </div>
    `
    )
    .join('');
  document.getElementById('review-total').textContent = formatMoney(Cart.getTotal(currentSlug));
}

async function onSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('checkout-error');
  errorEl.textContent = '';

  const form = e.target;
  const customerName = form.customerName.value.trim();
  const customerPhone = form.customerPhone.value.trim();
  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value;

  if (!customerName || !customerPhone) {
    errorEl.textContent = 'Please enter your name and phone number.';
    return;
  }
  if (!paymentMethod) {
    errorEl.textContent = 'Please choose a payment method.';
    return;
  }

  const cart = Cart.getCart(currentSlug);
  const payload = {
    storeSlug: currentSlug,
    customerName,
    customerPhone,
    customerEmail: form.customerEmail.value.trim(),
    deliveryAddress: form.deliveryAddress.value.trim(),
    notes: form.notes.value.trim(),
    paymentMethod,
    items: cart.map((line) => ({ variantId: line.variantId, qty: line.qty }))
  };

  const submitBtn = document.getElementById('place-order-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Placing order…';

  const res = await Api.post('createOrder', payload);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Place Order';

  if (!res.ok) {
    errorEl.textContent = `${res.error || 'Something went wrong.'} You can also send your order directly using the buttons below once you confirm your details.`;
    showFallbackConfirmation(payload, cart);
    return;
  }

  Cart.clearCart(currentSlug);
  showConfirmation(res, payload);
}

function buildSummaryText(orderRef, payload, cart, total) {
  const lines = cart.map((l) => `- ${l.qty} x ${l.label} = ${formatMoney(l.unitPrice * l.qty)}`).join('\n');
  const paymentBlock =
    payload.paymentMethod === 'ANZ'
      ? `ANZ Bank Transfer\nAccount Name: ${storeInfo.anzAccountName || 'N/A'}\nAccount Number: ${storeInfo.anzAccountNumber || 'N/A'}\nBranch: ${storeInfo.anzBranch || 'N/A'}`
      : `Teremo\nNumber: ${storeInfo.teremoNumber || 'N/A'}\nName: ${storeInfo.teremoName || 'N/A'}`;

  return `${storeInfo.storeName} - Order
${orderRef ? 'Order Ref: ' + orderRef : '(order not yet confirmed with the store server — please send this message directly)'}

Customer: ${payload.customerName}
Phone: ${payload.customerPhone}
${payload.deliveryAddress ? 'Address: ' + payload.deliveryAddress + '\n' : ''}${payload.notes ? 'Notes: ' + payload.notes + '\n' : ''}
Items:
${lines}

Total: ${formatMoney(total)}

Payment Method: ${payload.paymentMethod}
${paymentBlock}
${orderRef ? 'Use ' + orderRef + ' as your payment reference.' : ''}
`;
}

function showConfirmation(orderResult, payload) {
  document.getElementById('checkout-section').classList.add('hidden');
  const confirmSection = document.getElementById('confirmation-section');
  confirmSection.classList.remove('hidden');

  document.getElementById('confirmation-intro').textContent = `Thank you, ${payload.customerName}! Your order reference is ${orderResult.orderId}.`;

  document.getElementById('confirmation-payment-panel').innerHTML =
    payload.paymentMethod === 'ANZ' ? document.getElementById('payment-instructions-anz').innerHTML : document.getElementById('payment-instructions-teremo').innerHTML;

  const summaryText = buildSummaryText(orderResult.orderId, payload, orderResult.items.map((i) => ({ label: i.label, unitPrice: i.unitPrice, qty: i.qty })), orderResult.total);
  document.getElementById('order-summary-text').value = summaryText;

  wireShareLinks(summaryText, orderResult.orderId);
}

function showFallbackConfirmation(payload, cart) {
  const total = Cart.getTotal(currentSlug);
  const summaryText = buildSummaryText(null, payload, cart, total);
  // Reuse the confirmation section as a manual fallback if the API call failed.
  document.getElementById('checkout-section').classList.add('hidden');
  document.getElementById('confirmation-section').classList.remove('hidden');
  document.getElementById('confirmation-intro').textContent = `We couldn't reach the store's order system, but you can still send your order directly, ${payload.customerName}.`;
  document.getElementById('confirmation-payment-panel').innerHTML =
    payload.paymentMethod === 'ANZ' ? document.getElementById('payment-instructions-anz').innerHTML : document.getElementById('payment-instructions-teremo').innerHTML;
  document.getElementById('order-summary-text').value = summaryText;
  wireShareLinks(summaryText, null);
}

function wireShareLinks(summaryText, orderRef) {
  const emailLink = document.getElementById('email-order-link');
  const whatsappLink = document.getElementById('whatsapp-order-link');

  if (storeInfo.email) {
    emailLink.href = `mailto:${encodeURIComponent(storeInfo.email)}?subject=${encodeURIComponent('Order ' + (orderRef || ''))}&body=${encodeURIComponent(summaryText)}`;
    emailLink.classList.remove('hidden');
  } else {
    emailLink.classList.add('hidden');
  }

  const digits = (storeInfo.phone || '').replace(/[^0-9]/g, '');
  if (digits) {
    whatsappLink.href = `https://wa.me/${digits}?text=${encodeURIComponent(summaryText)}`;
    whatsappLink.classList.remove('hidden');
  } else {
    whatsappLink.classList.add('hidden');
  }
}

async function onCopySummary() {
  const text = document.getElementById('order-summary-text').value;
  const feedback = document.getElementById('copy-feedback');
  try {
    await navigator.clipboard.writeText(text);
    feedback.textContent = 'Copied to clipboard.';
  } catch (err) {
    const textarea = document.getElementById('order-summary-text');
    textarea.select();
    document.execCommand('copy');
    feedback.textContent = 'Copied to clipboard.';
  }
  setTimeout(() => {
    feedback.textContent = '';
  }, 3000);
}
