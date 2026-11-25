/**
 * Price-drop intelligence + the automatic store-activity triggers (CESN Stage
 * 5-6). runEngagementSweep compares every active variant against its last-seen
 * state in ProductWatch and emits, through emitEngagementEvent, three automatic
 * categories:
 *   price_drop     retail price fell by >= CESN_PRICE_DROP_PCT (default 10%)
 *   new_arrival    a product that has never been seen before
 *   back_in_stock  stock went from 0 to positive
 *
 * Price drops use the verified previous selling price and guard against the
 * "raise then discount" trick: a drop counts only if the previous price had
 * stood for at least CESN_PRICE_DWELL_HOURS (resetting the dwell clock whenever
 * the price changes), and the same (or lower) price is never notified twice.
 * Retail and wholesale are tracked under separate PriceType rows, so a
 * wholesale change never fires a retail-price notification.
 *
 * Dormant until the owner adds a time trigger that calls runEngagementSweep
 * (like warmPublicCaches / runMarketingSweep). It does network I/O (push) via
 * the engine, so it runs OUTSIDE any lock, on a schedule - never inline with a
 * shopper request.
 */

function cesnStoreName_(slug) {
  var o = getOwnerBySlug(slug);
  return (o && o.StoreName) || 'this store';
}

function cesnMoney_(n) {
  var v = Number(n);
  if (isNaN(v)) return '';
  return (Math.round(v * 100) / 100).toString();
}

function runEngagementSweep() {
  var cfg = cesnConfig();
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };

  var prodById = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (String(p.Status) === 'active') prodById[String(p.ProductId)] = p;
  });
  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return String(v.Status) === 'active'; });

  var watchSheet = getSheet('ProductWatch');
  var watch = sheetToObjects(watchSheet);
  var key = function (pid, vid, ptype) { return pid + '|' + vid + '|' + ptype; };
  var watchIndex = {};
  var knownProduct = {};
  watch.forEach(function (w) { watchIndex[key(w.ProductId, w.VariantId, w.PriceType)] = w; knownProduct[String(w.ProductId)] = true; });

  var now = Date.now();
  var nowStr = nowIso();
  var events = [];

  variants.forEach(function (v) {
    var p = prodById[String(v.ProductId)];
    if (!p) return;
    var slug = String(p.StoreSlug);
    var price = Number(v.Price);
    if (isNaN(price) || price <= 0) return;              // unpublished / invalid price: ignore
    var stock = Number(v.StockQty); if (isNaN(stock)) stock = 0;
    var k = key(String(v.ProductId), String(v.VariantId), 'retail');
    var w = watchIndex[k];

    if (!w) {
      appendRowFromObject(watchSheet, {
        WatchId: newId('pw'), ProductId: v.ProductId, VariantId: v.VariantId, StoreSlug: slug,
        PriceType: 'retail', LastPrice: price, PriceSince: nowStr, LastStock: stock,
        LastNotifiedPrice: '', FirstSeenAt: nowStr, UpdatedAt: nowStr
      });
      // New arrival only when the PRODUCT is brand new (not merely a new variant
      // of a known product), and once per product per sweep.
      if (!knownProduct[String(v.ProductId)]) {
        knownProduct[String(v.ProductId)] = true;
        events.push({
          storeSlug: slug, category: 'new_arrival', productId: v.ProductId,
          title: 'New at ' + cesnStoreName_(slug), body: (p.Name || 'A new product') + ' is now listed.',
          deepLink: 'product.html?id=' + encodeURIComponent(v.ProductId), imageUrl: p.ImageUrl || '',
          sourceKey: 'new:' + v.ProductId
        });
      }
      return;
    }

    var lastPrice = Number(w.LastPrice);
    var lastStock = Number(w.LastStock);
    var patch = { LastStock: stock, UpdatedAt: nowStr };

    if ((isNaN(lastStock) || lastStock <= 0) && stock > 0) {
      events.push({
        storeSlug: slug, category: 'back_in_stock', productId: v.ProductId,
        title: 'Back in stock at ' + cesnStoreName_(slug), body: (p.Name || 'An item') + ' is available again.',
        deepLink: 'product.html?id=' + encodeURIComponent(v.ProductId), imageUrl: p.ImageUrl || '',
        sourceKey: 'stock:' + v.VariantId + ':' + Math.floor(now / 86400000)
      });
    }

    if (!isNaN(lastPrice) && price < lastPrice) {
      var pct = (lastPrice - price) / lastPrice * 100;
      var sinceMs = new Date(w.PriceSince).getTime();
      var dwelledLongEnough = isNaN(sinceMs) ? true : (now - sinceMs) >= cfg.dwellHours * 3600000;
      var alreadyNotified = String(w.LastNotifiedPrice) !== '' && Number(w.LastNotifiedPrice) <= price;
      if (pct >= cfg.dropPct && dwelledLongEnough && !alreadyNotified) {
        events.push({
          storeSlug: slug, category: 'price_drop', productId: v.ProductId,
          title: Math.round(pct) + '% off at ' + cesnStoreName_(slug),
          body: (p.Name || 'An item') + ' is down from ' + cesnMoney_(lastPrice) + ' to ' + cesnMoney_(price) + '.',
          deepLink: 'product.html?id=' + encodeURIComponent(v.ProductId), imageUrl: p.ImageUrl || '',
          sourceKey: 'drop:' + v.VariantId + ':' + price
        });
        patch.LastNotifiedPrice = price;
      }
      // Any price change resets the dwell clock (so a later raise-then-drop is caught).
      patch.LastPrice = price; patch.PriceSince = nowStr;
    } else if (!isNaN(lastPrice) && price > lastPrice) {
      patch.LastPrice = price; patch.PriceSince = nowStr;
    }

    updateRowFromObject(watchSheet, w.__row, patch);
  });

  var queued = 0;
  events.forEach(function (e) { var r = emitEngagementEvent(e); queued += (r.queued || 0); });
  return { ok: true, events: events.length, queued: queued };
}
