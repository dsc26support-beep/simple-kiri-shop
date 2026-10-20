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

  // Where this store stands in Mwakete's checks (Badges.gs, STORE CHECKS):
  // the seller sees which checks are done, never who did them or notes.
  var snap = dashRows('SellerBadges').filter(function (r) { return String(r.OwnerId) === String(owner.OwnerId); })[0] || {};
  var snapIds = String(snap.Badges || 'unchecked').split(',');
  var snapMetrics = {};
  try { snapMetrics = JSON.parse(snap.MetricsJson || '{}'); } catch (e) { snapMetrics = {}; }
  var tier = storeTrustTier(snapIds);
  var cfg = badgeConfig();
  var storeCheck = {
    status: tier === 2 ? 'verified' : (tier === 1 ? 'new' : 'unchecked'),
    call: !!owner.CheckCall, email: !!owner.CheckEmail, visit: !!owner.CheckVisit,
    reviews: Number(snapMetrics.reviews) || 0,
    rating: snapMetrics.rating == null ? null : Number(snapMetrics.rating),
    minRating: badgeNum(cfg, 'verified.autoMinRating'), minReviews: badgeNum(cfg, 'verified.autoMinReviews')
  };

  return ok({
    storeCheck: storeCheck,
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

/* ==================== Platform admin overview ==================== */

/**
 * Admin only (isOwnerAdmin; a seller session is refused and logged). The
 * whole marketplace at a glance, from the same rows every other admin tool
 * reads. Deliberately no customer names, phones or addresses: order lines
 * carry the reference, store, total and status - admin search is the place to
 * look a person up. body.days: 7 (default) or 30.
 */
function actionGetAdminOverview(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'getAdminOverview');
  var period = Number(body && body.days) === 30 ? 30 : 7;
  var now = Date.now();
  var today = headerAdToday(now), yesterday = headerAdToday(now - 86400000);
  var days = dashLastDays(period, now);
  var since = days[0];

  var owners = sheetToObjects(getSheet('Owners'));
  var stores = owners.filter(function (o) { return (o.Status === 'active' || o.Status === 'standby') && !isOwnerAdmin(o) && !isAdminNamedStore(o); });
  var storeById = {};
  owners.forEach(function (o) { storeById[o.OwnerId] = o; });
  var orders = sheetToObjects(getSheet('Orders')).filter(function (o) { var s = storeById[o.OwnerId]; return s && !isOwnerAdmin(s); });
  var summary = summariseSellerOrders(orders, days, today, yesterday);

  // Top stores by confirmed sales in the period.
  var byStore = {};
  orders.forEach(function (o) {
    var d = dashDayOf(o.CreatedAt);
    if (d < since || d > today) return;
    var b = byStore[o.OwnerId] || (byStore[o.OwnerId] = { ownerId: o.OwnerId, orders: 0, sales: 0 });
    b.orders++;
    if (DASH_CONFIRMED_STATUSES.indexOf(String(o.Status)) !== -1) b.sales = roundMoney(b.sales + (Number(o.Total) || 0));
  });
  var top = Object.keys(byStore).map(function (k) { return byStore[k]; })
    .sort(function (a, b) { return b.sales - a.sales || b.orders - a.orders; }).slice(0, 8)
    .map(function (b) { var s = storeById[b.ownerId] || {}; return { storeName: s.StoreName || '', storeSlug: s.StoreSlug || '', storeType: storeTypeOf(s), orders: b.orders, sales: b.sales }; });

  // Sellers and customers.
  var newStores = stores.filter(function (s) { var d = dashDayOf(s.CreatedAt); return d && d >= since; }).length;
  var types = { retailer: 0, wholesaler: 0, distributor: 0 };
  stores.forEach(function (s) { types[storeTypeOf(s)]++; });
  var unverifiedBulk = stores.filter(function (s) { return storeTypeOf(s) !== 'retailer' && String(s.WholesaleVerified) !== 'true'; }).length;
  var customers = dashRows('Customers');
  var newCustomers = customers.filter(function (c) { var d = dashDayOf(c.CreatedAt); return d && d >= since; }).length;

  // Work waiting on an admin.
  var feature = dashRows('FeaturePurchases');
  var featurePending = feature.filter(function (r) { return r.Status === FEATURE_STATUS.PENDING; }).length;
  var featureUnmatched = feature.filter(function (r) { return r.Status === FEATURE_STATUS.APPROVED && !r.BankMatchedAt; }).length;
  var reviewOpen = dashRows('Product_Review_Queue').filter(function (r) { return REVIEW_OPEN_STATUSES.indexOf(String(r.Status)) !== -1; }).length;
  var disputes = dashRows('TxDisputes');
  var openDisputes = disputes.filter(function (d) { return typeof TX_DISPUTE_OPEN !== 'undefined' && TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1; });
  var refundsDue = dashRows('TxState').filter(function (s) { return s.RefundState === 'due'; }).length;
  var staleUnpaid = orders.filter(function (o) {
    return String(o.Status) === 'Pending Payment' && now - new Date(o.CreatedAt).getTime() > 3 * 86400000;
  }).length;

  // Stock across the marketplace (tracked varieties of live listings only).
  var liveProducts = {};
  dashRows('Products').forEach(function (p) { if (p.Status === 'active') liveProducts[p.ProductId] = true; });
  var stockByStore = {};
  var outTotal = 0, lowTotal = 0;
  dashRows('Variants').forEach(function (v) {
    if (v.Status !== 'active' || !liveProducts[v.ProductId]) return;
    var h = stockHealthOf(v);
    if (h !== 'out' && h !== 'low') return;
    if (h === 'out') outTotal++; else lowTotal++;
    var s = stockByStore[v.OwnerId] || (stockByStore[v.OwnerId] = { out: 0, low: 0 });
    s[h]++;
  });
  var stockStores = Object.keys(stockByStore).map(function (id) {
    var s = storeById[id] || {};
    return { storeName: s.StoreName || '', storeSlug: s.StoreSlug || '', out: stockByStore[id].out, low: stockByStore[id].low };
  }).sort(function (a, b) { return b.out - a.out || b.low - a.low; }).slice(0, 5);

  orders.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });
  var recent = orders.slice(0, 8).map(function (o) {
    var s = storeById[o.OwnerId] || {};
    return { orderId: o.OrderId, storeName: s.StoreName || '', total: o.Total, status: o.Status, createdAt: o.CreatedAt,
      problem: openDisputes.some(function (d) { return d.OrderId === o.OrderId; }) };
  });

  return ok({
    today: today, period: period,
    kpis: Object.assign(summary.kpis, {
      activeStores: stores.length, newStores: newStores, storeTypes: types, customers: customers.length, newCustomers: newCustomers
    }),
    series: summary.series,
    work: {
      featurePending: featurePending, featureUnmatched: featureUnmatched, reviewOpen: reviewOpen, openDisputes: openDisputes.length,
      refundsDue: refundsDue, staleUnpaid: staleUnpaid, unverifiedBulk: unverifiedBulk
    },
    stock: { out: outTotal, low: lowTotal, stores: stockStores },
    topStores: top,
    recentOrders: recent,
    roomsMode: typeof txMode === 'function' ? txMode() : 'off'
  });
}
