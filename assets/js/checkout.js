document.addEventListener('DOMContentLoaded', init);

let currentSlug = null;
let storeInfo = null;

const CHECKOUT_PROFILE_KEY = 'skiri_checkout_profile';
// Villages a truck route physically reaches at the South Tarawa/North Tarawa
// causeway boundary - fuzzy-matched (case/1-typo insensitive). Used both as
// an inclusion list (South Tarawa vendor -> these North Tarawa villages) and
// an exclusion list (North Tarawa vendor -> everywhere on North Tarawa
// EXCEPT these three) - see computeEligibleDeliveryMethods below.
const TRUCK_ELIGIBLE_VILLAGES = ['buota', 'abatao', 'tabiteuea'];

async function init() {
  currentSlug = localStorage.getItem('skiri_active_store');
  const errorEl = document.getElementById('checkout-error');

  if (!currentSlug || Cart.getCart(currentSlug).length === 0) {
    window.location.href = 'cart.html';
    return;
  }

  document.getElementById('back-to-cart-link').href = 'cart.html';

  populateCheckoutIslandSelect();
  wireCheckoutLocationFields();
  document.getElementById('delivery-method-options').addEventListener('change', updateReviewTotal);
  prefillSavedCheckoutProfile();

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
  updateDeliveryMethods();

  document.getElementById('checkout-form').addEventListener('submit', onSubmit);
  document.getElementById('copy-summary-btn').addEventListener('click', onCopySummary);
  document.getElementById('customer-email').addEventListener('blur', onEmailBlur);
}

/* ---------- Saved checkout profile (same device, next time) ---------- */

function loadSavedCheckoutProfile() {
  try {
    return JSON.parse(localStorage.getItem(CHECKOUT_PROFILE_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function saveCheckoutProfile(profile) {
  try {
    localStorage.setItem(CHECKOUT_PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {
    // storage full/unavailable - not worth failing checkout over
  }
}

function prefillSavedCheckoutProfile() {
  const saved = loadSavedCheckoutProfile();
  if (!saved) return;

  document.getElementById('customer-name').value = saved.customerName || '';
  document.getElementById('customer-phone').value = saved.customerPhone || '';
  document.getElementById('customer-email').value = saved.customerEmail || '';

  if (saved.island) {
    document.getElementById('checkout-island').value = saved.island;
    populateCheckoutVillageSelect(saved.island, saved.village || '');
  }
}

/* ---------- Island / village selects (mirrors owner-settings.js) ---------- */

function populateCheckoutIslandSelect() {
  const select = document.getElementById('checkout-island');
  select.innerHTML = ['<option value="">Select an island…</option>']
    .concat(Object.keys(KIRIBATI_ISLANDS).map((island) => `<option value="${escapeHtml(island)}">${escapeHtml(island)}</option>`))
    .join('');
}

function populateCheckoutVillageSelect(island, selectedVillage) {
  const villageSelect = document.getElementById('checkout-village');
  const otherField = document.getElementById('checkout-village-other-field');
  const otherInput = document.getElementById('checkout-village-other');
  const villages = KIRIBATI_ISLANDS[island] || [];

  villageSelect.innerHTML = ['<option value="">Select a village…</option>']
    .concat(villages.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
    .concat([`<option value="${escapeHtml(KIRIBATI_OTHER_VILLAGE)}">${escapeHtml(KIRIBATI_OTHER_VILLAGE)}</option>`])
    .join('');

  if (selectedVillage && villages.indexOf(selectedVillage) !== -1) {
    villageSelect.value = selectedVillage;
    otherField.classList.add('hidden');
    otherInput.value = '';
  } else if (selectedVillage) {
    villageSelect.value = KIRIBATI_OTHER_VILLAGE;
    otherField.classList.remove('hidden');
    otherInput.value = selectedVillage;
  } else {
    villageSelect.value = '';
    otherField.classList.add('hidden');
    otherInput.value = '';
  }
}

function wireCheckoutLocationFields() {
  document.getElementById('checkout-island').addEventListener('change', (e) => {
    populateCheckoutVillageSelect(e.target.value, '');
    updateDeliveryMethods();
  });

  document.getElementById('checkout-village').addEventListener('change', (e) => {
    const otherField = document.getElementById('checkout-village-other-field');
    if (e.target.value === KIRIBATI_OTHER_VILLAGE) {
      otherField.classList.remove('hidden');
    } else {
      otherField.classList.add('hidden');
      document.getElementById('checkout-village-other').value = '';
    }
    updateDeliveryMethods();
  });

  document.getElementById('checkout-village-other').addEventListener('input', updateDeliveryMethods);
}

function getCustomerIsland() {
  return document.getElementById('checkout-island').value;
}

function getCustomerVillage() {
  const villageSelect = document.getElementById('checkout-village');
  if (villageSelect.value === KIRIBATI_OTHER_VILLAGE) {
    return document.getElementById('checkout-village-other').value.trim();
  }
  return villageSelect.value;
}

/* ---------- Delivery method eligibility ---------- */

function customerVillageMatchesTruckList(customerVillage) {
  const tokens = tokenizeProductName(customerVillage);
  return tokens.some((t) => TRUCK_ELIGIBLE_VILLAGES.some((target) => wordsAreEquivalent(t, target)));
}

/**
 * Client-side mirror of the server's computeEligibleDeliveryMethods in
 * Orders.gs - this is only for UI (showing/hiding options); the server
 * re-derives the same rules and is the actual source of truth, since this
 * endpoint is public and unauthenticated.
 *
 * Eligibility is organized around the VENDOR's own island:
 *  - South Tarawa vendor: truck to South Tarawa + the 3 listed North Tarawa
 *    villages; ship blocked to South Tarawa only; air blocked to South/North
 *    Tarawa only.
 *  - North Tarawa vendor: truck to North Tarawa EXCEPT the 3 listed
 *    villages; ship ("boat") to South Tarawa only, as the one exception that
 *    lets them reach off-island at all; air never available.
 *  - Any other (outer island) vendor: truck only to their own same island;
 *    ship and air only to South Tarawa.
 */
function computeEligibleDeliveryMethods(subtotal) {
  if (!storeInfo) return [];
  const customerIsland = getCustomerIsland();
  const customerVillage = getCustomerVillage();
  const storeIsland = storeInfo.island || '';
  const eligible = [];
  const shipOk = storeInfo.deliveryShip && subtotal >= 500;

  if (storeIsland === 'South Tarawa') {
    if (storeInfo.deliveryTruck) {
      if (customerIsland === 'South Tarawa') eligible.push('truck');
      else if (customerIsland === 'North Tarawa' && customerVillageMatchesTruckList(customerVillage)) eligible.push('truck');
    }
    if (shipOk && customerIsland !== 'South Tarawa') eligible.push('ship');
    if (storeInfo.deliveryAirCargo && customerIsland !== 'South Tarawa' && customerIsland !== 'North Tarawa') eligible.push('airCargo');
  } else if (storeIsland === 'North Tarawa') {
    if (storeInfo.deliveryTruck && customerIsland === 'North Tarawa' && !customerVillageMatchesTruckList(customerVillage)) eligible.push('truck');
    if (shipOk && customerIsland === 'South Tarawa') eligible.push('ship');
    // Air Cargo is never offered by a North Tarawa vendor.
  } else {
    if (storeInfo.deliveryTruck && customerIsland === storeIsland) eligible.push('truck');
    if (shipOk && customerIsland === 'South Tarawa') eligible.push('ship');
    if (storeInfo.deliveryAirCargo && customerIsland === 'South Tarawa') eligible.push('airCargo');
  }

  return eligible;
}

function updateDeliveryMethods() {
  if (!storeInfo) return;
  const subtotal = Cart.getTotal(currentSlug);
  renderDeliveryMethodOptions(computeEligibleDeliveryMethods(subtotal));
}

function renderDeliveryMethodOptions(eligible) {
  const container = document.getElementById('delivery-method-options');
  const helpEl = document.getElementById('delivery-method-help');
  const placeOrderBtn = document.getElementById('place-order-btn');

  const previouslyChecked = container.querySelector('input[name="deliveryMethod"]:checked');
  const previousValue = previouslyChecked ? previouslyChecked.value : null;

  if (eligible.length === 0) {
    container.innerHTML = '';
    helpEl.textContent = document.getElementById('checkout-island').value
      ? "This store can't deliver to your island/village with an available method. Double-check your selection above, or contact the store directly."
      : 'Choose your island and village first — available delivery methods depend on where you and the store are.';
    placeOrderBtn.disabled = true;
    updateReviewTotal();
    return;
  }

  helpEl.textContent = '';
  placeOrderBtn.disabled = false;

  container.innerHTML = eligible
    .map((m, i) => {
      const cost = storeInfo[m + 'Cost'];
      const priceText = cost == null ? '' : cost === 0 ? ' — Free' : ` — ${formatMoney(cost)}`;
      const checked = previousValue ? m === previousValue : i === 0;
      return `
        <label class="delivery-method-option">
          <input type="radio" name="deliveryMethod" value="${m}" ${checked ? 'checked' : ''}>
          ${DELIVERY_ICON_SVG[m]}
          <span>${escapeHtml(DELIVERY_ICON_LABELS[m])}${priceText}</span>
        </label>
      `;
    })
    .join('');

  updateReviewTotal();
}

function updateReviewTotal() {
  const subtotal = Cart.getTotal(currentSlug);
  const selected = document.querySelector('input[name="deliveryMethod"]:checked');
  const deliveryCost = selected && storeInfo && storeInfo[selected.value + 'Cost'] != null ? storeInfo[selected.value + 'Cost'] : 0;
  document.getElementById('review-total').textContent = formatMoney(subtotal + deliveryCost);
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
  const customerEmail = form.customerEmail.value.trim();
  const island = getCustomerIsland();
  const village = getCustomerVillage();
  const deliveryMethodInput = document.querySelector('input[name="deliveryMethod"]:checked');

  if (!customerName || !customerPhone) {
    errorEl.textContent = 'Please enter your name and phone number.';
    return;
  }
  if (!island || !village) {
    errorEl.textContent = 'Please select your island and village.';
    return;
  }
  if (!deliveryMethodInput) {
    errorEl.textContent = 'Please choose a delivery method.';
    return;
  }

  saveCheckoutProfile({ customerName, customerPhone, customerEmail, island, village });

  const cart = Cart.getCart(currentSlug);
  const payload = {
    storeSlug: currentSlug,
    customerName,
    customerPhone,
    customerEmail,
    island,
    village,
    deliveryAddress: `${village}, ${island}`,
    deliveryMethod: deliveryMethodInput.value,
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
  const deliveryLabel = payload.deliveryMethod ? DELIVERY_ICON_LABELS[payload.deliveryMethod] : '';

  return `${storeInfo.storeName} - New Order
${orderRef ? 'Order Ref: ' + orderRef : '(order not yet confirmed with the store server — please send this message directly)'}

Customer: ${payload.customerName}
Phone: ${payload.customerPhone}
${payload.deliveryAddress ? 'Address: ' + payload.deliveryAddress + '\n' : ''}${deliveryLabel ? 'Delivery Method: ' + deliveryLabel + '\n' : ''}${payload.notes ? 'Notes: ' + payload.notes + '\n' : ''}
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
  // Copy/Email fallback buttons), while clicking the anchor just invokes the
  // OS mail handler without navigating the current page.
  if (storeInfo.email) {
    document.getElementById('email-order-link').click();
  }
}

function showFallbackConfirmation(payload, cart) {
  const deliveryCost = payload.deliveryMethod && storeInfo && storeInfo[payload.deliveryMethod + 'Cost'] != null ? storeInfo[payload.deliveryMethod + 'Cost'] : 0;
  const total = Cart.getTotal(currentSlug) + deliveryCost;
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

  if (storeInfo.email) {
    emailLink.href = `mailto:${encodeURIComponent(storeInfo.email)}?subject=${encodeURIComponent('Order ' + (orderRef || ''))}&body=${encodeURIComponent(summaryText)}`;
    emailLink.classList.remove('hidden');
  } else {
    emailLink.classList.add('hidden');
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
