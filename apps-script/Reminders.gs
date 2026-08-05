/**
 * Two follow-up email campaigns that need a scheduled sweep, since Apps
 * Script has no built-in cron:
 *  - Abandoned cart: a customer typed an email at checkout but never placed
 *    the order. After a delay, email them a "still interested?" nudge.
 *  - No-email order: an order came in with no customer email on file, so
 *    there's no way to auto-reach the customer about payment. After a
 *    delay, email the STORE OWNER to call/WhatsApp the customer directly.
 *
 * runReminderSweep() must be wired to a time-driven trigger by hand once
 * (Apps Script editor > Triggers > Add Trigger > runReminderSweep >
 * Time-driven > Hour timer) - see README.
 */

var REMINDER_DELAY_MS = 60 * 60 * 1000; // 1 hour

function actionSaveAbandonedCart(body) {
  var slug = String(body.storeSlug || '').trim();
  var email = String(body.email || '').trim();
  // Silently no-op on bad input rather than fail() - this fires quietly in
  // the background while someone is filling in a form, it must never block
  // or interrupt checkout.
  if (!slug || !email || email.indexOf('@') === -1) return ok({});

  var owner = getOwnerBySlug(slug);
  if (!owner || owner.Status !== 'active') return ok({});

  // Only the bare identifiers/qty are kept - no client-supplied display text
  // (e.g. an item "label") is ever persisted here. runReminderSweep()
  // re-derives real product names from the live catalog before emailing, so
  // this can't be used to inject attacker-chosen text into an email sent to
  // an address the client also fully controls. See docs/security-audit.md.
  var items = (Array.isArray(body.items) ? body.items : [])
    .map(function (i) {
      return {
        productId: String(i.productId || ''),
        variantId: String(i.variantId || ''),
        qty: Math.max(1, parseInt(i.qty, 10) || 1)
      };
    })
    .filter(function (i) { return i.productId && i.variantId; });
  var cartJson = JSON.stringify(items);

  var sheet = getSheet('AbandonedCarts');
  var existing = sheetToObjects(sheet).filter(function (r) {
    return r.StoreSlug === slug && String(r.Email).toLowerCase() === email.toLowerCase() && !r.ConvertedOrderId;
  })[0];

  if (existing) {
    // Refresh the timer and cart contents rather than stacking duplicate
    // rows every time the customer edits their cart before checking out.
    updateRowFromObject(sheet, existing.__row, { CartJson: cartJson, CreatedAt: nowIso(), Reminded: '' });
  } else {
    appendRowFromObject(sheet, {
      Id: newId('cart'),
      StoreSlug: slug,
      OwnerId: owner.OwnerId,
      Email: email,
      CartJson: cartJson,
      CreatedAt: nowIso(),
      Reminded: '',
      ConvertedOrderId: ''
    });
  }
  return ok({});
}

/** Called from actionCreateOrder so a completed checkout never gets an "abandoned cart" nudge for the order it just placed. */
function markAbandonedCartConverted(storeSlug, email, orderId) {
  if (!email) return;
  var sheet = getSheet('AbandonedCarts');
  sheetToObjects(sheet)
    .filter(function (r) {
      return r.StoreSlug === storeSlug && String(r.Email).toLowerCase() === String(email).toLowerCase() && !r.ConvertedOrderId;
    })
    .forEach(function (r) { updateRowFromObject(sheet, r.__row, { ConvertedOrderId: orderId }); });
}

function runReminderSweep() {
  var now = Date.now();

  var cartsSheet = getSheet('AbandonedCarts');
  var dueCarts = sheetToObjects(cartsSheet).filter(function (r) {
    return !r.Reminded && !r.ConvertedOrderId && (now - new Date(r.CreatedAt).getTime()) >= REMINDER_DELAY_MS;
  });

  if (dueCarts.length > 0) {
    // Loaded once for every due cart, not per-row - these reminders can
    // fire in a batch and every cart needs the same live catalog lookup.
    var products = sheetToObjects(getSheet('Products'));
    var variants = sheetToObjects(getSheet('Variants'));

    dueCarts.forEach(function (r) {
      var owner = findRowById(getSheet('Owners'), 'OwnerId', r.OwnerId);
      if (!owner || owner.Status !== 'active') return;

      var items = [];
      try { items = JSON.parse(r.CartJson || '[]'); } catch (e) { /* malformed row, ignore */ }

      // Display names are re-derived from the live catalog, never trusted
      // from the stored cart - see actionSaveAbandonedCart above and
      // docs/security-audit.md. Also scoped to this store's own variants so
      // a productId/variantId that doesn't belong to this owner can't pull
      // another store's product name into the email.
      var lines = items.map(function (i) {
        var variant = variants.filter(function (v) { return v.VariantId === i.variantId && v.OwnerId === r.OwnerId; })[0];
        var product = variant ? products.filter(function (p) { return p.ProductId === variant.ProductId; })[0] : null;
        var label = product ? (product.Name + (variant.Label ? ' - ' + variant.Label : '')) : 'an item';
        return '- ' + (i.qty || 1) + ' x ' + label;
      }).join('\n');

      var subject = 'You left something in your cart at ' + owner.StoreName;
      var body = 'Hi,\n\n' +
        'You started an order at ' + owner.StoreName + ' but didn\'t finish checking out:\n\n' +
        (lines || '(cart details unavailable)') + '\n\n' +
        'If you\'d still like these items, just visit the store and check out again.\n\n' +
        'If you already sorted this out another way, you can ignore this email.';

      sendAppEmail(r.Email, subject, body);
      updateRowFromObject(cartsSheet, r.__row, { Reminded: nowIso() });
    });
  }

  var ordersSheet = getSheet('Orders');
  sheetToObjects(ordersSheet)
    .filter(function (o) {
      return !o.CustomerEmail && o.Status === 'Pending Payment' && !o.NoEmailReminderSent &&
        (now - new Date(o.CreatedAt).getTime()) >= REMINDER_DELAY_MS;
    })
    .forEach(function (o) {
      var owner = findRowById(getSheet('Owners'), 'OwnerId', o.OwnerId);
      if (!owner || !owner.Email) return;

      var subject = 'Reminder: call ' + o.CustomerName + ' about order ' + o.OrderId;
      var body = 'Hi ' + owner.StoreName + ',\n\n' +
        'Customer ' + o.CustomerName + ' placed order ' + o.OrderId + ' but didn\'t leave an email address, ' +
        'so there\'s no automatic way to reach them about payment.\n\n' +
        'Please call or WhatsApp them at ' + o.CustomerPhone + ' to confirm the order and arrange payment.\n\n' +
        'Items: ' + o.ItemsSummary + '\nTotal: ' + o.Total;

      sendAppEmail(owner.Email, subject, body);
      updateRowFromObject(ordersSheet, o.__row, { NoEmailReminderSent: nowIso() });
    });

  // Piggybacks on this sweep's already-required hourly trigger (see README)
  // rather than needing a second trigger wired up separately - without this,
  // Sessions only ever grows (see pruneExpiredSessions in Auth.gs), and
  // every authenticated request scans the whole table via requireAuth.
  pruneExpiredSessions();
}
