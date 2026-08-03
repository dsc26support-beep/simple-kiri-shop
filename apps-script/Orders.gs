/**
 * Order creation and management.
 *
 * The exec URL is public and unauthenticated for createOrder, so prices and
 * the order reference are always derived server-side from the live Variants
 * rows - the client's submitted prices are never trusted.
 */

var VALID_ORDER_STATUSES = ['Pending Payment', 'Paid', 'Fulfilled', 'Cancelled'];

function actionCreateOrder(body) {
  var slug = body.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!owner || owner.Status !== 'active') return fail('Store not found');

  var requestedItems = Array.isArray(body.items) ? body.items : [];
  if (requestedItems.length === 0) return fail('Your cart is empty');

  var customerName = String(body.customerName || '').trim();
  var customerPhone = String(body.customerPhone || '').trim();
  var paymentMethod = body.paymentMethod || '';
  if (!customerName || !customerPhone) return fail('Name and phone number are required');

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

    var orderId = generateOrderRef(slug);
    appendRowFromObject(getSheet('Orders'), {
      OrderId: orderId,
      OwnerId: owner.OwnerId,
      StoreSlug: slug,
      CustomerName: customerName,
      CustomerPhone: customerPhone,
      CustomerEmail: body.customerEmail || '',
      DeliveryAddress: body.deliveryAddress || '',
      Notes: body.notes || '',
      PaymentMethod: paymentMethod,
      PaymentReference: orderId,
      ItemsJson: JSON.stringify(lineItems),
      ItemsSummary: summaryParts.join(', '),
      Subtotal: subtotal,
      Total: subtotal,
      Status: 'Pending Payment',
      CreatedAt: nowIso(),
      UpdatedAt: nowIso()
    });

    return ok({
      orderId: orderId,
      total: subtotal,
      paymentMethod: paymentMethod,
      store: publicOwnerFields(owner),
      items: lineItems
    });
  } finally {
    lock.releaseLock();
  }
}

function actionListOwnerOrders(owner) {
  var orders = sheetToObjects(getSheet('Orders')).filter(function (o) { return o.OwnerId === owner.OwnerId; });
  orders.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });

  var result = orders.map(function (o) {
    var items = [];
    try { items = JSON.parse(o.ItemsJson || '[]'); } catch (e) { /* malformed row, ignore */ }
    return {
      orderId: o.OrderId,
      customerName: o.CustomerName,
      customerPhone: o.CustomerPhone,
      customerEmail: o.CustomerEmail,
      deliveryAddress: o.DeliveryAddress,
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

  return ok({ orders: result });
}

function actionUpdateOrderStatus(owner, body) {
  if (VALID_ORDER_STATUSES.indexOf(body.status) === -1) return fail('Invalid status');
  var sheet = getSheet('Orders');
  var existing = findRowById(sheet, 'OrderId', body.orderId);
  if (!existing || existing.OwnerId !== owner.OwnerId) return fail('Order not found');
  updateRowFromObject(sheet, existing.__row, { Status: body.status, UpdatedAt: nowIso() });
  return ok({});
}
