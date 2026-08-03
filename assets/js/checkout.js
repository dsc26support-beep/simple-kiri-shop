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

  if (storeInfo.logoUrl) {
    const logoImg = document.getElementById('store-logo-img');
    logoImg.src = storeInfo.logoUrl;
    logoImg.alt = storeInfo.storeName;
    logoImg.classList.remove('hidden');
  }

  const phoneLine = document.getElementById('store-phone-line');
  if (storeInfo.phone) {
    phoneLine.textContent = storeInfo.phone;
    phoneLine.classList.remove('hidden');
  }

  document.getElementById('store-delivery-icons').innerHTML = renderDeliveryIcons({
    truck: storeInfo.deliveryTruck,
    ship: storeInfo.deliveryShip,
    airCargo: storeInfo.deliveryAirCargo,
    truckCost: storeInfo.deliveryTruckCost,
    shipCost: storeInfo.deliveryShipCost,
    airCargoCost: storeInfo.deliveryAirCargoCost
  });

  renderOrderReview();

  document.getElementById('checkout-form').addEventListener('submit', onSubmit);
  document.getElementById('copy-summary-btn').addEventListener('click', onCopySummary);
  document.getElementById('customer-email').addEventListener('blur', onEmailBlur);
}

// Fire-and-forget: if the customer has typed a plausible email but hasn't
// placed the order yet, record it so an abandoned-cart reminder can follow
// up later if they never come back to finish checking out. Never blocks or
// shows errors - this must stay invisible to a customer who's just filling
// in a form.
function onEmailBlur(e) {
  const email = e.target.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return;

  const cart = Cart.getCart(currentSlug);
  Api.post('saveAbandonedCart', {
    storeSlug: currentSlug,
    email,
    items: cart.map((line) => ({ label: line.label, qty: line.qty }))
  }).catch(() => {});
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

  if (!customerName || !customerPhone) {
    errorEl.textContent = 'Please enter your name and phone number.';
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

  return `${storeInfo.storeName} - New Order
${orderRef ? 'Order Ref: ' + orderRef : '(order not yet confirmed with the store server — please send this message directly)'}

Customer: ${payload.customerName}
Phone: ${payload.customerPhone}
${payload.deliveryAddress ? 'Address: ' + payload.deliveryAddress + '\n' : ''}${payload.notes ? 'Notes: ' + payload.notes + '\n' : ''}
Items:
${lines}

Total: ${formatMoney(total)}

Hi, I'd like to place this order. Could you please reply and let me know how you'd like me to arrange payment?${storeInfo.phone ? ' You can also reach me by phone/WhatsApp at ' + payload.customerPhone + ', or call/WhatsApp the store at ' + storeInfo.phone + '.' : ''}

Thank you!
`;
}

function showConfirmation(orderResult, payload) {
  document.getElementById('checkout-section').classList.add('hidden');
  const confirmSection = document.getElementById('confirmation-section');
  confirmSection.classList.remove('hidden');

  document.getElementById('confirmation-intro').textContent =
    `Thank you, ${payload.customerName}! Your order reference is ${orderResult.orderId}. We're opening an email to the store now — if it doesn't open automatically, use the buttons below.`;

  const summaryText = buildSummaryText(orderResult.orderId, payload, orderResult.items.map((i) => ({ label: i.label, unitPrice: i.unitPrice, qty: i.qty })), orderResult.total);
  document.getElementById('order-summary-text').value = summaryText;

  wireShareLinks(summaryText, orderResult.orderId);

  // Click the mailto link rather than assigning window.location.href - the
  // latter can trigger a real page navigation/reload in some mobile browsers
  // when no mail app is configured (losing this confirmation screen and its
  // Copy/Email/WhatsApp fallback buttons), while clicking the anchor just
  // invokes the OS mail handler without navigating the current page.
  if (storeInfo.email) {
    document.getElementById('email-order-link').click();
  }
}

function showFallbackConfirmation(payload, cart) {
  const total = Cart.getTotal(currentSlug);
  const summaryText = buildSummaryText(null, payload, cart, total);
  // Reuse the confirmation section as a manual fallback if the API call failed.
  // No auto-redirect here - there's no server-confirmed order yet, so the
  // customer should review and send it themselves rather than being pushed
  // into an email prematurely.
  document.getElementById('checkout-section').classList.add('hidden');
  document.getElementById('confirmation-section').classList.remove('hidden');
  document.getElementById('confirmation-intro').textContent = `We couldn't reach the store's order system, but you can still send your order directly, ${payload.customerName}.`;
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
