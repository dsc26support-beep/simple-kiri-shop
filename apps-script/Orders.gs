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

  return eligible;
}

var DELIVERY_COST_FIELD = { truck: 'DeliveryTruckCost', ship: 'DeliveryShipCost', airCargo: 'DeliveryAirCargoCost' };

function actionCreateOrder(body) {
  var slug = body.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!owner || owner.Status !== 'active') return fail('Store not found');

  var requestedItems = Array.isArray(body.items) ? body.items : [];
  if (requestedItems.length === 0) return fail('Your cart is empty');

  var customerName = String(body.customerName || '').trim();
  var customerPhone = String(body.customerPhone || '').trim();
  var island = String(body.island || '').trim();
  var village = String(body.village || '').trim();
  var deliveryMethod = String(body.deliveryMethod || '').trim();
  var paymentMethod = body.paymentMethod || '';
  if (!customerName || !customerPhone) return fail('Name and phone number are required');
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
    var deliveryCost = Number(owner[DELIVERY_COST_FIELD[deliveryMethod]]) || 0;
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
      DeliveryCost: deliveryCost,
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

    return ok({
      orderId: orderId,
      total: total,
      deliveryMethod: deliveryMethod,
      deliveryCost: deliveryCost,
      paymentMethod: paymentMethod,
      store: publicOwnerFields(owner),
      items: lineItems
    });
  } finally {
    lock.releaseLock();
  }
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
