/**
 * Order creation and management.
 *
 * The exec URL is public and unauthenticated for createOrder, so prices and
 * the order reference are always derived server-side from the live Variants
 * rows - the client's submitted prices are never trusted.
 */

var VALID_ORDER_STATUSES = ['Pending Payment', 'Paid', 'Fulfilled', 'Cancelled'];

// Villages a truck route physically reaches at the South Tarawa/North Tarawa
// causeway boundary - fuzzy-matched (case/1-typo insensitive) against
// whichever village the customer selects. Used both as an inclusion list (a
// South Tarawa vendor's truck can reach these North Tarawa villages) and as
// an exclusion list (a North Tarawa vendor's truck can NOT reach these three
// villages within their own island - same list, opposite effect).
var TRUCK_ELIGIBLE_VILLAGES = ['buota', 'abatao', 'tabiteuea'];

function customerVillageMatchesTruckList(customerVillage) {
  var villageWords = String(customerVillage || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
  return villageWords.some(function (w) {
    return TRUCK_ELIGIBLE_VILLAGES.some(function (target) { return wordsAreEquivalent(w, target); });
  });
}

/**
 * Mirrors the client-side eligibility check in checkout.js - re-derived here
 * so a crafted request can't unlock a delivery method the UI would have
 * hidden (e.g. Ship under the $500 minimum, or Air Cargo across a route the
 * store doesn't actually serve).
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
 * Pick & Pay (in-person pickup at the store, always free) sits outside all
 * of the above - it doesn't involve a physical delivery route, so it's
 * eligible for ANY customer location whenever the vendor has it enabled,
 * unlike truck/ship/airCargo which depend on where the vendor and customer
 * each are.
 */
function computeEligibleDeliveryMethods(owner, customerIsland, customerVillage, subtotal) {
  var eligible = [];
  var storeIsland = owner.Island || '';
  var hasTruck = String(owner.DeliveryTruck) === 'true';
  var hasShip = String(owner.DeliveryShip) === 'true';
  var hasAirCargo = String(owner.DeliveryAirCargo) === 'true';
  var shipOk = hasShip && subtotal >= 500;

  if (storeIsland === 'South Tarawa') {
    if (hasTruck) {
      if (customerIsland === 'South Tarawa') eligible.push('truck');
      else if (customerIsland === 'North Tarawa' && customerVillageMatchesTruckList(customerVillage)) eligible.push('truck');
    }
    if (shipOk && customerIsland !== 'South Tarawa') eligible.push('ship');
    if (hasAirCargo && customerIsland !== 'South Tarawa' && customerIsland !== 'North Tarawa') eligible.push('airCargo');
  } else if (storeIsland === 'North Tarawa') {
    if (hasTruck && customerIsland === 'North Tarawa' && !customerVillageMatchesTruckList(customerVillage)) eligible.push('truck');
    if (shipOk && customerIsland === 'South Tarawa') eligible.push('ship');
    // Air Cargo is never offered by a North Tarawa vendor.
  } else {
    if (hasTruck && customerIsland === storeIsland) eligible.push('truck');
    if (shipOk && customerIsland === 'South Tarawa') eligible.push('ship');
    if (hasAirCargo && customerIsland === 'South Tarawa') eligible.push('airCargo');
  }

  if (String(owner.DeliveryPickPay) === 'true') eligible.push('pickPay');

  return eligible;
}

// Pick & Pay has no cost field/column - it's always free, deliberately left
// out of this map. DELIVERY_COST_FIELD['pickPay'] is undefined, so the
// actionCreateOrder lookup below resolves to 0 either way, but the delivery
// cost line there spells it out explicitly rather than relying on that.
var DELIVERY_COST_FIELD = { truck: 'DeliveryTruckCost', ship: 'DeliveryShipCost', airCargo: 'DeliveryAirCargoCost' };

// Human-readable delivery-method names for the seller-notification email.
var DELIVERY_METHOD_LABEL = { truck: 'Truck', ship: 'Boat / Ship', airCargo: 'Air Cargo', pickPay: 'Pick & Pay (in-person pickup)' };

function orderMoney(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

// Plain-text order notification sent to the seller the moment an order is
// placed. Mirrors the on-screen order summary the customer sees so the vendor
// has the full order in their inbox without opening the dashboard.
function buildSellerOrderEmail(owner, orderId, name, phone, email, island, village, method, deliveryCost, lineItems, subtotal, total, notes, shippingNegotiated) {
  var lines = lineItems.map(function (l) {
    return '- ' + l.qty + ' x ' + l.label + ' = ' + orderMoney(l.lineTotal);
  }).join('\n');
  var methodLabel = DELIVERY_METHOD_LABEL[method] || method;
  // Trailing arg, so any caller that predates it still behaves as before.
  var deliveryText = shippingNegotiated
    ? 'To Be Negotiated - contact the customer to agree the fee'
    : Number(deliveryCost) === 0 ? 'Free' : orderMoney(deliveryCost);

  return 'New order received on Mwakete.\n\n' +
    'Order Ref: ' + orderId + '\n' +
    'Store: ' + owner.StoreName + '\n\n' +
    'Customer: ' + name + '\n' +
    'Phone: ' + phone + '\n' +
    (email ? 'Email: ' + email + '\n' : '') +
    'Deliver to: ' + village + ', ' + island + '\n' +
    'Delivery Method: ' + methodLabel + ' (' + deliveryText + ')\n\n' +
    'Items:\n' + lines + '\n\n' +
    'Subtotal: ' + orderMoney(subtotal) + '\n' +
    'Delivery: ' + deliveryText + '\n' +
    'Total: ' + orderMoney(total) + '\n\n' +
    'Notes: ' + (notes ? notes : '(none)') + '\n\n' +
    'The customer has been asked to call you to arrange payment.';
}

// Server mirror of the client isCustomerPhoneValid (§16). Local Kiribati
// numbers (+686/00686/686 prefix, or no country code) must start 730 or 630;
// any other explicit country code is overseas and unrestricted. Never rely on
// the frontend check alone - createOrder is public/unauthenticated.
function isCustomerPhoneValid(phone) {
  var s = String(phone || '').replace(/[\s()\-.]/g, '');
  var hasCountryCode = false;
  if (s.charAt(0) === '+') { s = s.slice(1); hasCountryCode = true; }
  else if (s.slice(0, 2) === '00') { s = s.slice(2); hasCountryCode = true; }

  var national, local;
  if (s.slice(0, 3) === '686') { local = true; national = s.slice(3); }
  else if (hasCountryCode) { local = false; national = s; }
  else { local = true; national = s; }

  if (!local) return true;
  return /^(730|630)/.test(national);
}

function actionCreateOrder(body) {
  var slug = body.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!isStoreBrowsable(owner)) return fail('Store not found');
  // Browsable but closed: the storefront and chat stay open, taking money
  // does not. Re-checked here because the client cannot be trusted to.
  if (!isStoreOpenForBusiness(owner)) {
    return fail('This store is closed right now and cannot take orders. You can still chat with them to ask when they reopen.');
  }

  var requestedItems = Array.isArray(body.items) ? body.items : [];
  if (requestedItems.length === 0) return fail('Your cart is empty');

  var customerName = String(body.customerName || '').trim();
  var customerPhone = String(body.customerPhone || '').trim();
  var island = String(body.island || '').trim();
  var village = String(body.village || '').trim();
  var deliveryMethod = String(body.deliveryMethod || '').trim();
  var paymentMethod = body.paymentMethod || '';
  if (!customerName || !customerPhone) return fail('Name and phone number are required');
  if (!isCustomerPhoneValid(customerPhone)) return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
  if (!island || !village) return fail('Island and village are required');
  var nameErr = capLength(customerName, 100, 'Name');
  if (nameErr) return nameErr;
  var islandErr = capLength(island, 100, 'Island');
  if (islandErr) return islandErr;
  var villageErr = capLength(village, 100, 'Village');
  if (villageErr) return villageErr;
  var notesErr = capLength(body.notes, 2000, 'Notes');
  if (notesErr) return notesErr;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var liveVariants = sheetToObjects(getSheet('Variants')).filter(function (v) {
      return v.OwnerId === owner.OwnerId && v.Status === 'active';
    });
    var products = sheetToObjects(getSheet('Products'));

    var lineItems = [];
    var summaryParts = [];
    var subtotal = 0;

    for (var i = 0; i < requestedItems.length; i++) {
      var variant = liveVariants.filter(function (v) { return v.VariantId === requestedItems[i].variantId; })[0];
      if (!variant) return fail('One of the items in your cart is no longer available. Please refresh your cart.');

      var qty = Math.max(1, parseInt(requestedItems[i].qty, 10) || 1);
      var unitPrice = Number(variant.Price);
      var lineTotal = unitPrice * qty;
      subtotal += lineTotal;

      var product = products.filter(function (p) { return p.ProductId === variant.ProductId; })[0];
      var productName = product ? product.Name : 'Item';

      lineItems.push({
        productId: variant.ProductId,
        variantId: variant.VariantId,
        label: productName + ' - ' + variant.Label,
        qty: qty,
        unitPrice: unitPrice,
        lineTotal: lineTotal
      });
      summaryParts.push(qty + '× ' + productName + ' ' + variant.Label);
    }

    var eligibleMethods = computeEligibleDeliveryMethods(owner, island, village, subtotal);
    if (eligibleMethods.indexOf(deliveryMethod) === -1) {
      return fail('That delivery method is not available for your location - please refresh and choose an available option.');
    }
    // A paid method whose cost cell the vendor never filled in means the fee
    // has to be agreed with the store - it is NOT free. Previously the
    // `|| 0` below silently turned a blank cell into $0, so the order was
    // written, totalled and emailed as free delivery. Record it as negotiated
    // instead: DeliveryCost is left blank (not 0) so the vendor can see the
    // fee is still open, and the unknown amount stays out of the total.
    var rawDeliveryCost = deliveryMethod === 'pickPay' ? 0 : owner[DELIVERY_COST_FIELD[deliveryMethod]];
    var shippingNegotiated = deliveryMethod !== 'pickPay' && (rawDeliveryCost === '' || rawDeliveryCost == null);
    var deliveryCost = shippingNegotiated ? 0 : Number(rawDeliveryCost) || 0;
    var total = subtotal + deliveryCost;

    var orderId = generateOrderRef(slug);
    appendRowFromObject(getSheet('Orders'), {
      OrderId: orderId,
      OwnerId: owner.OwnerId,
      StoreSlug: slug,
      CustomerName: customerName,
      CustomerPhone: customerPhone,
      CustomerEmail: body.customerEmail || '',
      Island: island,
      Village: village,
      DeliveryAddress: village + ', ' + island,
      DeliveryMethod: deliveryMethod,
      // Blank, not 0, when the fee is still to be agreed - a 0 here would be
      // indistinguishable from genuinely free delivery.
      DeliveryCost: shippingNegotiated ? '' : deliveryCost,
      Notes: body.notes || '',
      PaymentMethod: paymentMethod,
      PaymentReference: orderId,
      ItemsJson: JSON.stringify(lineItems),
      ItemsSummary: summaryParts.join(', '),
      Subtotal: subtotal,
      Total: total,
      Status: 'Pending Payment',
      CreatedAt: nowIso(),
      UpdatedAt: nowIso()
    });

    if (body.customerEmail) markAbandonedCartConverted(slug, body.customerEmail, orderId);
  } finally {
    lock.releaseLock();
  }

  // Notify the seller by email now that the order is safely written. Done
  // outside the lock (the send can be slow, and it must not block or roll back
  // a committed order). We report whether it went out via emailedSeller so the
  // customer's confirmation screen can confirm the seller was emailed before
  // showing the "Order Received" page.
  var emailedSeller = false;
  if (owner.Email) {
    emailedSeller = sendAppEmail(
      owner.Email,
      'New order ' + orderId + ' — ' + customerName,
      buildSellerOrderEmail(owner, orderId, customerName, customerPhone, body.customerEmail, island, village, deliveryMethod, deliveryCost, lineItems, subtotal, total, body.notes, shippingNegotiated)
    );
  }

  return ok({
    orderId: orderId,
    total: total,
    deliveryMethod: deliveryMethod,
    deliveryCost: deliveryCost,
    paymentMethod: paymentMethod,
    store: publicStoreFields(owner),
    items: lineItems,
    emailedSeller: emailedSeller
  });
}

/**
 * Paginated via body.limit/offset (same shape as actionListStores/
 * actionListOwnerProducts/actionGetVendorConversations) - see
 * docs/production-readiness-report.md Finding 10. Sorted newest-first
 * before slicing so the page boundary is stable across repeated calls
 * (new orders only ever get created, never reordered).
 */
function actionListOwnerOrders(owner, body) {
  body = body || {};
  var allOrders = sheetToObjects(getSheet('Orders')).filter(function (o) { return o.OwnerId === owner.OwnerId; });
  allOrders.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });

  var limit = clampPageSize(body.limit, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  var offset = Math.max(0, Number(body.offset) || 0);
  var orders = allOrders.slice(offset, offset + limit);

  var result = orders.map(function (o) {
    var items = [];
    try { items = JSON.parse(o.ItemsJson || '[]'); } catch (e) { /* malformed row, ignore */ }
    return {
      orderId: o.OrderId,
      customerName: o.CustomerName,
      customerPhone: o.CustomerPhone,
      customerEmail: o.CustomerEmail,
      island: o.Island,
      village: o.Village,
      deliveryAddress: o.DeliveryAddress,
      deliveryMethod: o.DeliveryMethod,
      deliveryCost: o.DeliveryCost,
      notes: o.Notes,
      paymentMethod: o.PaymentMethod,
      paymentReference: o.PaymentReference,
      items: items,
      itemsSummary: o.ItemsSummary,
      total: o.Total,
      status: o.Status,
      createdAt: o.CreatedAt
    };
  });

  return ok({ orders: result, total: allOrders.length, hasMore: offset + limit < allOrders.length });
}

function actionUpdateOrderStatus(owner, body) {
  if (VALID_ORDER_STATUSES.indexOf(body.status) === -1) return fail('Invalid status');
  var sheet = getSheet('Orders');
  var existing = findRowById(sheet, 'OrderId', body.orderId);
  if (!existing || existing.OwnerId !== owner.OwnerId) return fail('Order not found');
  updateRowFromObject(sheet, existing.__row, { Status: body.status, UpdatedAt: nowIso() });
  return ok({});
}
