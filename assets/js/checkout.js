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

  const hideOverlay = showLoadingOverlay();
  const res = await Api.get('getStorePublicInfo', { storeSlug: currentSlug });
  hideOverlay();
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not load this store.';
    document.getElementById('place-order-btn').disabled = true;
    // Say the options failed to load - never that the store cannot deliver.
    showDeliveryLoadError();
    return;
  }
  storeInfo = res.store;
  // publicOwnerFields exposes isOpen; share it with the chat window.
  window.__storeOpen = storeInfo.isOpen !== false;
  document.getElementById('store-name-tagline').textContent = `Checkout — ${storeInfo.storeName}`;

  if (storeInfo.logoUrl) {
    const logoImg = document.getElementById('store-logo-img');
    logoImg.src = optimizedImageUrl(storeInfo.logoUrl, IMG_W.logo);
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
    pickPay: storeInfo.deliveryPickPay,
    truckCost: storeInfo.deliveryTruckCost,
    shipCost: storeInfo.deliveryShipCost,
    airCargoCost: storeInfo.deliveryAirCargoCost
  });

  renderOrderReview();
  updateDeliveryMethods();

  document.getElementById('checkout-form').addEventListener('submit', onSubmit);
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
 *
 * Pick & Pay (in-person pickup, always free) is eligible for any customer
 * location whenever the vendor has it enabled - it doesn't involve a
 * delivery route, so none of the island/village logic above applies to it.
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

  if (storeInfo.deliveryPickPay) eligible.push('pickPay');

  return eligible;
}

function updateDeliveryMethods() {
  if (!storeInfo) return;
  const subtotal = Cart.getTotal(currentSlug);
  renderDeliveryMethodOptions(computeEligibleDeliveryMethods(subtotal));
}

// storeInfo's cost fields are named deliveryTruckCost/deliveryShipCost/
// deliveryAirCargoCost (see publicOwnerFields in Auth.gs) - not
// "<method>Cost". pickPay has no cost field at all since it's always free.
function deliveryCostOf(m) {
  if (m === 'pickPay') return 0;
  return storeInfo['delivery' + m[0].toUpperCase() + m.slice(1) + 'Cost'];
}

// A paid method whose fee the vendor has never filled in. publicOwnerFields
// maps a blank cost cell to null and a real zero to 0, so null is
// unambiguously "not set" - it must never be presented or charged as Free,
// which is what happened before. Pick & Pay is the one method free by design.
function isNegotiatedDelivery(m) {
  return m !== 'pickPay' && deliveryCostOf(m) == null;
}

// Reuse the store chat that is already on this page rather than adding a
// second contact path.
function openStoreChat() {
  var fab = document.getElementById('chat-fab');
  if (fab) fab.click();
}

function hideDeliveryAlert() {
  const el = document.getElementById('delivery-alert');
  el.className = 'delivery-alert hidden';
  el.innerHTML = '';
}

// "We know the options, and none reach you." Always offers a way out so the
// customer is never stuck: change the destination above, or open the chat.
function showDeliveryUnavailable() {
  const el = document.getElementById('delivery-alert');
  el.className = 'delivery-alert delivery-alert--unavailable';
  el.innerHTML =
    '<p class="delivery-alert-text">This store can\'t deliver to your island/village with an available method. ' +
    'Double-check your selection above, or contact the store directly.</p>' +
    '<button type="button" class="btn btn-small delivery-alert-btn" id="delivery-contact-store">Contact Store</button>';
  document.getElementById('delivery-contact-store').addEventListener('click', openStoreChat);
}

// Distinct from the above on purpose: here the store's delivery configuration
// never loaded, so we do NOT know what is available. Saying "this store can't
// deliver" would be a guess presented as fact, so this is a neutral error with
// a retry instead.
function showDeliveryLoadError() {
  const el = document.getElementById('delivery-alert');
  el.className = 'delivery-alert delivery-alert--failed';
  el.innerHTML =
    '<p class="delivery-alert-text">We could not load this store\'s delivery options just now. ' +
    'This does not mean the store cannot deliver to you.</p>' +
    '<button type="button" class="btn btn-small delivery-alert-btn" id="delivery-retry">Try again</button>';
  document.getElementById('delivery-retry').addEventListener('click', () => window.location.reload());
}

function renderDeliveryMethodOptions(eligible) {
  const container = document.getElementById('delivery-method-options');
  const helpEl = document.getElementById('delivery-method-help');
  const placeOrderBtn = document.getElementById('place-order-btn');

  const previouslyChecked = container.querySelector('input[name="deliveryMethod"]:checked');
  const previousValue = previouslyChecked ? previouslyChecked.value : null;

  if (eligible.length === 0) {
    container.innerHTML = '';
    if (document.getElementById('checkout-island').value) {
      helpEl.textContent = '';
      showDeliveryUnavailable();
    } else {
      helpEl.textContent = 'Choose your island and village first — available delivery methods depend on where you and the store are.';
      hideDeliveryAlert();
    }
    placeOrderBtn.disabled = true;
    updateReviewTotal();
    return;
  }

  hideDeliveryAlert();
  helpEl.textContent = '';
  placeOrderBtn.disabled = false;

  // Default the selection to Pick & Pay when it's available (it's free and
  // needs no delivery arrangement) - otherwise the first eligible method.
  // A previously-chosen method always wins on re-render.
  // Keep the customer's choice only while it is still eligible - changing
  // island used to leave a stale value selected (or nothing checked at all)
  // while Place Order stayed enabled.
  const keepPrevious = previousValue && eligible.indexOf(previousValue) !== -1;
  const defaultMethod = keepPrevious ? previousValue : (eligible.indexOf('pickPay') !== -1 ? 'pickPay' : eligible[0]);

  container.innerHTML = eligible
    .map((m) => {
      const cost = deliveryCostOf(m);
      // null = fee never set -> negotiated; 0 = genuinely free.
      const priceText = cost == null ? ' — To Be Negotiated' : cost === 0 ? ' — Free' : ` — ${formatMoney(cost)}`;
      const checked = m === defaultMethod;
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
  const cost = selected && storeInfo ? deliveryCostOf(selected.value) : null;
  const negotiated = !!(selected && storeInfo && isNegotiatedDelivery(selected.value));
  // An unknown fee is not zero. It stays out of the total rather than silently
  // adding $0 and presenting the result as a final price.
  const deliveryCost = negotiated || cost == null ? 0 : cost;

  document.getElementById('review-subtotal').textContent = formatMoney(subtotal);

  const deliveryRow = document.getElementById('delivery-review-row');
  if (selected) {
    deliveryRow.classList.remove('hidden');
    document.getElementById('delivery-review-label').textContent = 'Delivery';
    document.getElementById('review-delivery-cost').textContent = negotiated
      ? 'To Be Negotiated'
      : deliveryCost === 0 ? 'Free' : formatMoney(deliveryCost);
  } else {
    deliveryRow.classList.add('hidden');
  }

  const noteEl = document.getElementById('delivery-negotiated-note');
  if (negotiated) {
    noteEl.textContent = 'Shipping fee and delivery date to be negotiated. Chat with store for more details.';
    noteEl.classList.remove('hidden');
  } else {
    noteEl.textContent = '';
    noteEl.classList.add('hidden');
  }

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
    items: cart.map((line) => ({ productId: line.productId, variantId: line.variantId, qty: line.qty }))
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
  document.getElementById('review-subtotal').textContent = formatMoney(Cart.getTotal(currentSlug));
  document.getElementById('delivery-review-row').classList.add('hidden');
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
  if (!isCustomerPhoneValid(customerPhone)) {
    errorEl.textContent = 'Local phone numbers must start with 730 or 630. For an overseas number, include your country code (e.g. +64…).';
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
  const hideOverlay = showLoadingOverlay();

  const res = await Api.post('createOrder', payload);

  hideOverlay();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Place Order';

  if (!res.ok) {
    errorEl.textContent = `${res.error || 'Something went wrong.'} You can also send your order directly using the buttons below once you confirm your details.`;
    showFallbackConfirmation(payload, cart);
    return;
  }

  Cart.clearCart(currentSlug);

  // The server emails the seller as part of createOrder and reports back
  // whether it went out. When it did, show a brief confirmation popup so the
  // customer knows the seller was notified, then reveal the Order Received
  // page. If the email couldn't be sent, fall straight through to the page
  // (the "Call Seller Now!" button is there for them either way).
  if (res.emailedSeller) {
    await showOrderSentPopup('The seller has been emailed about your order.', 2600);
  }

  showConfirmation(res, payload);
}

function buildSummaryText(orderRef, payload, cart, total, deliveryCost) {
  const lines = cart.map((l) => `- ${l.qty} x ${l.label} = ${formatMoney(l.unitPrice * l.qty)}`).join('\n');
  const deliveryLabel = payload.deliveryMethod ? DELIVERY_ICON_LABELS[payload.deliveryMethod] : '';
  const subtotal = cart.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
  const deliveryCostLine = deliveryCost != null ? `Delivery Cost: ${deliveryCost === 0 ? 'Free' : formatMoney(deliveryCost)}\n` : '';

  return `${storeInfo.storeName} - New Order
${orderRef ? 'Order Ref: ' + orderRef : '(order not yet confirmed with the store server — please send this message directly)'}

Customer: ${payload.customerName}
Phone: ${payload.customerPhone}
${payload.deliveryAddress ? 'Address: ' + payload.deliveryAddress + '\n' : ''}${deliveryLabel ? 'Delivery Method: ' + deliveryLabel + '\n' : ''}${payload.notes ? 'Notes: ' + payload.notes + '\n' : ''}
Items:
${lines}

Subtotal: ${formatMoney(subtotal)}
${deliveryCostLine}Total: ${formatMoney(total)}

Hi, I'd like to place this order. Could you please reply and let me know how you'd like me to arrange payment?

Ko rabwa!
`;
}

function showConfirmation(orderResult, payload) {
  document.getElementById('checkout-section').classList.add('hidden');
  const confirmSection = document.getElementById('confirmation-section');
  confirmSection.classList.remove('hidden');

  document.getElementById('confirmation-intro').textContent =
    `Thank you, ${payload.customerName}! Your order reference is ${orderResult.orderId}.`;

  const summaryText = buildSummaryText(orderResult.orderId, payload, orderResult.items.map((i) => ({ label: i.label, unitPrice: i.unitPrice, qty: i.qty })), orderResult.total, orderResult.deliveryCost);
  document.getElementById('order-summary-text').value = summaryText;

  wireCallLink();
}

function showFallbackConfirmation(payload, cart) {
  const fallbackCost = payload.deliveryMethod && storeInfo ? deliveryCostOf(payload.deliveryMethod) : null;
  const deliveryCost = fallbackCost != null ? fallbackCost : 0;
  const total = Cart.getTotal(currentSlug) + deliveryCost;
  const summaryText = buildSummaryText(null, payload, cart, total, fallbackCost);
  // Reuse the confirmation section as a manual fallback if the API call failed.
  // No auto-redirect here - there's no server-confirmed order yet, so the
  // customer should review and send it themselves rather than being pushed
  // into an email prematurely.
  document.getElementById('checkout-section').classList.add('hidden');
  document.getElementById('confirmation-section').classList.remove('hidden');
  document.getElementById('confirmation-intro').textContent = `We couldn't reach the store's order system, but you can still send your order directly, ${payload.customerName}.`;
  document.getElementById('order-summary-text').value = summaryText;
  wireCallLink();
}

// The post-order action is now a single green "Call Seller Now!" button (a tel:
// link to the store's phone). Stores always register a phone, but guard anyway.
function wireCallLink() {
  const callLink = document.getElementById('call-seller-link');
  if (storeInfo && storeInfo.phone) {
    callLink.href = `tel:${storeInfo.phone}`;
    callLink.innerHTML = PHONE_ICON_SVG + 'Call Seller Now!';
    callLink.classList.remove('hidden');
  } else {
    callLink.classList.add('hidden');
  }
}
