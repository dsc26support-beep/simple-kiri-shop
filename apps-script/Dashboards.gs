/**
 * Dashboard summaries (Oct 2026 dashboard modernisation). Read-only: every
 * figure is computed here from the authoritative rows - Orders, Variants,
 * Products, Bookings, the order-room and listing-review tabs - for the one
 * signed-in owner (the session decides whose rows; the page never says).
 * Nothing is cached across owners and nothing is written.
 *
 * Money: an order counts as a SALE once the seller has confirmed payment
 * (Status Paid or Fulfilled). Pending and cancelled orders are counted as
 * orders but never as sales, so the figure never claims money that has not
 * arrived. Days are Kiribati calendar days (UTC+12, headerAdToday).
 */

var DASH_CONFIRMED_STATUSES = ['Paid', 'Fulfilled'];

function dashDayOf(iso) {
  var t = new Date(iso).getTime();
  return isNaN(t) ? '' : headerAdToday(t);
}

function dashRows(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  return sheet ? sheetToObjects(sheet) : [];
}

/** The last `n` Kiribati days, oldest first, ending today. */
function dashLastDays(n, nowMs) {
  var out = [];
  for (var i = n - 1; i >= 0; i--) out.push(headerAdToday((nowMs || Date.now()) - i * 86400000));
  return out;
}

/**
 * Pure: KPIs + a daily series from a seller's orders. Kept separate from the
 * sheet reads so the arithmetic is tested on its own.
 */
function summariseSellerOrders(orders, days, today, yesterday) {
  var series = {};
  days.forEach(function (d) { series[d] = { day: d, sales: 0, orders: 0 }; });
  var k = { ordersToday: 0, ordersYesterday: 0, salesToday: 0, salesYesterday: 0, pendingPayment: 0, confirmedTotal: 0 };
  orders.forEach(function (o) {
    var d = dashDayOf(o.CreatedAt);
    var confirmed = DASH_CONFIRMED_STATUSES.indexOf(String(o.Status)) !== -1;
    var total = roundMoney(Number(o.Total) || 0);
    if (String(o.Status) === 'Pending Payment') k.pendingPayment++;
    if (d === today) { k.ordersToday++; if (confirmed) k.salesToday = roundMoney(k.salesToday + total); }
    if (d === yesterday) { k.ordersYesterday++; if (confirmed) k.salesYesterday = roundMoney(k.salesYesterday + total); }
    if (series[d]) {
      series[d].orders++;
      if (confirmed) series[d].sales = roundMoney(series[d].sales + total);
    }
  });
  var list = days.map(function (d) { return series[d]; });
  k.periodSales = roundMoney(list.reduce(function (s, x) { return s + x.sales; }, 0));
  k.periodOrders = list.reduce(function (s, x) { return s + x.orders; }, 0);
  return { kpis: k, series: list };
}

/** Protected. body.days: 7 (default) or 30. */
function actionGetSellerDashboard(owner, body) {
  var period = Number(body && body.days) === 30 ? 30 : 7;
  var now = Date.now();
  var today = headerAdToday(now), yesterday = headerAdToday(now - 86400000);
  var orders = sheetToObjects(getSheet('Orders')).filter(function (o) { return o.OwnerId === owner.OwnerId; });
  var summary = summariseSellerOrders(orders, dashLastDays(period, now), today, yesterday);

  // Order rooms: open problems and unread activity on this seller's orders.
  var states = {};
  dashRows('TxState').forEach(function (s) { states[s.OrderId] = s; });
  var openDisputes = {};
  dashRows('TxDisputes').forEach(function (d) {
    if (typeof TX_DISPUTE_OPEN !== 'undefined' && TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1) openDisputes[d.OrderId] = d;
  });
  var problems = orders.filter(function (o) { return openDisputes[o.OrderId]; });
  var roomUnread = orders.reduce(function (n, o) {
    var s = states[o.OrderId];
    return n + (s ? Math.max(0, (Number(s.LastSeq) || 0) - (Number(s.ReadSellerSeq) || 0)) : 0);
  }, 0);

  orders.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });
  var roomsOn = typeof txEnabledForStore === 'function' && txEnabledForStore(owner.StoreSlug);
  var recent = orders.slice(0, 6).map(function (o) {
    var s = states[o.OrderId];
    return { orderId: o.OrderId, customerName: o.CustomerName, total: o.Total, status: o.Status, createdAt: o.CreatedAt,
      itemsSummary: o.ItemsSummary, room: roomsOn, problem: !!openDisputes[o.OrderId],
      stage: s && typeof txStageLabel === 'function' ? txStageLabel(o, s, openDisputes[o.OrderId] || null) : '' };
  });

  // Stock: only varieties this seller tracks; untracked ones are unlimited.
  var products = {};
  dashRows('Products').forEach(function (p) { if (p.OwnerId === owner.OwnerId) products[p.ProductId] = p; });
  var low = [], outCount = 0, lowCount = 0;
  dashRows('Variants').forEach(function (v) {
    if (v.OwnerId !== owner.OwnerId || v.Status !== 'active') return;
    var p = products[v.ProductId];
    if (!p || p.Status === 'archived') return;
    var h = stockHealthOf(v);
    if (h === 'out') outCount++;
    if (h === 'low') lowCount++;
    if (h === 'out' || h === 'low') low.push({ productId: v.ProductId, name: p.Name, label: v.Label, available: availableOf(v), health: h });
  });
  low.sort(function (a, b) { return (a.available || 0) - (b.available || 0); });
  var productList = Object.keys(products).map(function (id) { return products[id]; });

  var bookingsPending = dashRows('Bookings').filter(function (b) { return b.OwnerId === owner.OwnerId && b.Status === 'Pending'; }).length;
  var reviewWaiting = dashRows('Product_Review_Queue').filter(function (r) {
    return r.SellerId === owner.OwnerId && ['AWAITING_SELLER', 'CORRECTION_REQUIRED'].indexOf(String(r.Status)) !== -1;
  }).length;
  var type = storeTypeOf(owner);

  return ok({
    today: today,
    period: period,
    storeType: type,
    kpis: Object.assign(summary.kpis, {
      lowStock: lowCount, outOfStock: outCount, openProblems: problems.length, roomUnread: roomUnread,
      needsAction: summary.kpis.pendingPayment + problems.length,
      activeProducts: productList.filter(function (p) { return p.Status === 'active'; }).length,
      heldProducts: productList.filter(function (p) { return p.Status === 'review'; }).length,
      bookingsPending: bookingsPending, reviewWaiting: reviewWaiting
    }),
    series: summary.series,
    recentOrders: recent,
    lowStock: low.slice(0, 5),
    problems: problems.slice(0, 5).map(function (o) { return { orderId: o.OrderId, category: (TX_DISPUTE_CATEGORIES[openDisputes[o.OrderId].Category] || {}).label || '' }; }),
    wholesale: type === 'retailer' ? null : {
      verified: String(owner.WholesaleVerified) === 'true',
      locations: dashRows('Locations').filter(function (l) { return l.OwnerId === owner.OwnerId && l.Status !== 'archived'; }).length,
      unitsOnHand: dashRows('Variants').reduce(function (n, v) {
        return v.OwnerId === owner.OwnerId && v.Status === 'active' && isStockTracked(v) ? n + physicalOf(v) : n;
      }, 0)
    }
  });
}
