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
// Bounds the hourly sweep's per-row work (JSON.parse, catalog lookups, email
// building) so it stops growing with total historical Orders/AbandonedCarts
// volume - rows older than this could never still be legitimately due, so
// they're skipped before any of that work runs. Does NOT reduce the
// underlying Sheets read (sheetToObjects has no server-side filter - see
// docs/production-readiness-report.md Finding 2); only bounds what happens
// after that read. Expressed as a multiple of REMINDER_DELAY_MS so the two
// stay proportionate if the delay is ever retuned - 48x gives a wide,
// deliberately generous margin so a trigger that's briefly late or misses a
// run doesn't silently lose a still-reachable row (see
// docs/production-readiness-report.md Finding 7).
var REMINDER_LOOKBACK_MS = 48 * REMINDER_DELAY_MS; // 48 hours

/**
 * True if createdAt is recent enough that a row could still legitimately be
 * due for a reminder - i.e. within REMINDER_LOOKBACK_MS of now. An
 * unparseable/malformed CreatedAt is treated as within-window (fails open)
 * rather than silently excluded, matching this codebase's general
 * malformed-data convention of degrading gracefully instead of losing rows
 * quietly. In practice a no-op either way: the existing due-check already
 * evaluates false for a NaN timestamp, so a malformed row was never
 * reminded before this change and still won't be - this just keeps that
 * from becoming an accidental side effect if the conditions are ever
 * reordered.
 */
function isWithinReminderLookback(createdAt) {
  var createdMs = new Date(createdAt).getTime();
  if (isNaN(createdMs)) return true;
  return (Date.now() - createdMs) <= REMINDER_LOOKBACK_MS;
}

/* ---------- Order/AbandonedCart archiving (Finding 7's remaining piece) ----------
 *
 * The lookback window above bounds the sweep's PER-ROW work, but not the
 * underlying Sheets read itself - sheetToObjects() (Db.gs) always reads a
 * sheet's entire used range, with no server-side filter, so the full
 * historical Orders/AbandonedCarts table is still read into memory every
 * hour no matter how few rows are actually due. The only way to bound that
 * read in a Sheets-backed design is to physically shrink the live sheet -
 * which is what this section does. See
 * docs/production-readiness-report.md Finding 2/7.
 */

var ORDER_ARCHIVE_AGE_MS = 365 * 24 * 60 * 60 * 1000; // ~12 months
var ORDERS_ARCHIVE_TAB_NAME = 'OrdersArchive';

/**
 * Archiving only activates once OrdersArchive exists AND its header row
 * matches Orders' exactly - appendRowFromObject (Db.gs) maps by the TARGET
 * sheet's own header names, so a typo'd/missing column in a manually
 * created tab wouldn't error, it would just silently write blanks into that
 * column for every archived row forever. Checking headers up front turns
 * that into a one-time Logger.log warning instead of quiet, permanent data
 * loss. Uses getSheetByName directly (not Db.gs's getSheet(), which
 * throws) since "the tab doesn't exist yet" is this feature's normal
 * not-configured state, not an error - same opt-in-via-Script-Properties
 * shape as the Cloudinary/Resend integrations, just gated on a Sheet tab's
 * existence instead. A deployment that never creates OrdersArchive keeps
 * archiving off forever, with zero risk of a new failure mode.
 */
function getOrdersArchiveSheet() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(ORDERS_ARCHIVE_TAB_NAME);
  if (!sheet) return null;

  var archiveHeaders = getHeaders(sheet);
  var ordersHeaders = getHeaders(getSheet('Orders'));
  var headersOk = ordersHeaders.every(function (h) { return archiveHeaders.indexOf(h) !== -1; });
  if (!headersOk) {
    Logger.log('OrdersArchive exists but its headers do not match Orders - skipping archiving. Expected: ' + ordersHeaders.join(','));
    return null;
  }
  return sheet;
}

/**
 * Moves Orders rows older than ORDER_ARCHIVE_AGE_MS into OrdersArchive and
 * deletes them from the live sheet - so the live sheet's read cost (this
 * sweep, the vendor dashboard's actionListOwnerOrders, actionUpdateOrderStatus's
 * findRowById scan) stays bounded by "recent orders," not total historical
 * volume. A vendor stops seeing an archived order in their dashboard the
 * moment it's archived - by design, not a bug: recovery, if ever needed, is
 * manual Sheet access by the Sheet owner, the same lever this app already
 * relies on everywhere else undocumented recovery is needed.
 */
function archiveOldOrders() {
  var archiveSheet = getOrdersArchiveSheet();
  if (!archiveSheet) return;

  var ordersSheet = getSheet('Orders');
  var now = Date.now();
  sheetToObjects(ordersSheet)
    .filter(function (o) { return (now - new Date(o.CreatedAt).getTime()) >= ORDER_ARCHIVE_AGE_MS; })
    .sort(function (a, b) { return b.__row - a.__row; }) // delete bottom-up so row numbers stay valid - same convention as pruneExpiredSessions/revokeAllSessions (Auth.gs)
    .forEach(function (o) {
      appendRowFromObject(archiveSheet, o); // the leftover __row key is harmless - appendRowFromObject only ever reads keys matching the target sheet's own headers
      ordersSheet.deleteRow(o.__row);
    });
}

var ABANDONED_CART_RETENTION_MS = ORDER_ARCHIVE_AGE_MS; // same ~12 months, for consistency

/**
 * Unlike Orders, nothing ever displays a historical AbandonedCarts row to
 * anyone - no vendor-facing page reads this table at all, only this sweep
 * and actionSaveAbandonedCart/markAbandonedCartConverted touch it - so
 * there's nothing to preserve, just delete. This also cleans up rows that
 * aged past REMINDER_LOOKBACK_MS without ever being reminded or converted,
 * which would otherwise sit forever. Always-on (no opt-in tab check needed,
 * unlike archiveOldOrders above) since it's pure deletion of data nothing
 * ever reads again.
 */
function deleteStaleAbandonedCarts() {
  var sheet = getSheet('AbandonedCarts');
  var now = Date.now();
  sheetToObjects(sheet)
    .filter(function (r) { return (now - new Date(r.CreatedAt).getTime()) >= ABANDONED_CART_RETENTION_MS; })
    .sort(function (a, b) { return b.__row - a.__row; })
    .forEach(function (r) { sheet.deleteRow(r.__row); });
}

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
    return !r.Reminded && !r.ConvertedOrderId && isWithinReminderLookback(r.CreatedAt) &&
      (now - new Date(r.CreatedAt).getTime()) >= REMINDER_DELAY_MS;
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
        isWithinReminderLookback(o.CreatedAt) &&
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

  // Runs after the reminder logic above so a cart/order gets its chance to
  // be reminded in this same run before either cleanup step touches it -
  // no real overlap at ~12 months vs. hours, but keeps the ordering
  // logically clean. See the "Order/AbandonedCart archiving" section above.
  archiveOldOrders();
  deleteStaleAbandonedCarts();
}
