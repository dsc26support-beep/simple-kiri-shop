/**
 * Seller badges: the metrics, the score and who gets what.
 *
 * NOTHING HERE RUNS ON A CUSTOMER REQUEST. The whole index is computed in one
 * pass by recomputeSellerBadges() - a time-driven trigger, or an admin pressing
 * the button - and written to the SellerBadges tab. The read path
 * (sellerBadgeIndex) does one cached read of that snapshot and nothing else.
 *
 * That split is the entire design. actionSearchProducts already reads Owners,
 * Variants, Products and Reviews in full on a cold cache; a page of 20 products
 * that had to ask "what badges does this seller have?" per card would turn one
 * expensive request into twenty. Instead the answer is precomputed and the
 * search builder does a dictionary lookup.
 *
 * A SELLER CANNOT INFLUENCE ANY OF THIS. Every input is a row only customers or
 * the system create - Reviews (customers only, enforced in Reviews.gs), Orders,
 * Messages, and the Owners join date. The two admin-controlled badges are read
 * from columns only an admin action writes. There is no request body anywhere
 * in this file.
 *
 * REQUIRES two tabs, created by setupSheets():
 *   SellerBadges: OwnerId | Badges | Score | MetricsJson | ReasonJson | UpdatedAt
 *   BadgeConfig:  Key | Value | UpdatedAt
 * and three Owners columns, added by ensureBadgeColumns() without rewriting the
 * header row: BadgeVerified | BadgeRecommended | BadgeSuppressed.
 *
 * Every read path tolerates all of that being absent and degrades to "no
 * badges", so a deployment that has not run setupSheets yet browses exactly as
 * it did before.
 */

/**
 * The ids the frontend knows. assets/js/badges.js holds the same list and drops
 * anything it does not recognise, so an id added here and not there would be
 * awarded, sent, and silently rendered as nothing. tests/test-badges.js compares
 * the two files rather than trusting them to stay in step.
 */
var BADGE_IDS = ['recommended', 'top', 'verified', 'responsive',
                 'delivery', 'favourite', 'popular', 'new'];

/* ---------- configuration ---------------------------------------------------
 *
 * A flat Key/Value tab rather than typed columns, so adding a threshold later
 * never means a schema migration on a live sheet. Anything absent falls back to
 * the default below, so an empty (or missing) tab is a working configuration.
 */

var BADGE_CONFIG_DEFAULTS = {
  // Which badges may be awarded at all. 'false' disables one site-wide.
  'enabled.recommended': 'true',
  'enabled.top': 'true',
  'enabled.verified': 'true',
  'enabled.responsive': 'true',
  'enabled.delivery': 'true',
  'enabled.favourite': 'true',
  'enabled.popular': 'true',
  'enabled.new': 'true',

  // Performance score weights, as specified. They are renormalised across
  // whichever components a seller actually has data for - see sellerScore().
  'weight.ratings': '30',
  'weight.orders': '20',
  'weight.responsiveness': '15',
  'weight.fulfilment': '15',
  'weight.cancellations': '10',
  'weight.complaints': '10',

  // Nothing performance-based is awarded below these, however good the ratio
  // looks. Five customers is not a track record, and one 5-star review is not
  // a rating - without a floor the top badge on the site would go to whoever
  // sold one item to a friend.
  'min.orders': '5',
  'min.reviews': '3',

  // Where "completed orders" stops earning more score. A seller with 25
  // fulfilled orders is established; 250 does not make them 10x more
  // trustworthy, and without a ceiling the badge just tracks store size.
  'target.orders': '25',

  'newSellerDays': '30',

  'top.score': '75',
  'top.minRating': '4.2',

  'recommended.score': '88',
  'recommended.minRating': '4.5',
  'recommended.minOrders': '15',

  'responsive.maxMedianMinutes': '360',
  'responsive.minReplies': '5',
  'responsive.windowDays': '90',

  'delivery.minFulfilRate': '0.9',
  'delivery.minOrders': '5',

  'favourite.minRepeatRate': '0.25',
  'favourite.minRating': '4.0',
  'favourite.minOrders': '5',

  // "Currently receiving strong customer interest" is a comparison, not an
  // absolute - so it is the top slice of stores by RECENT orders, with a floor
  // so a quiet week cannot hand it to a store with one sale.
  'popular.windowDays': '30',
  'popular.minRecentOrders': '3',
  'popular.topFraction': '0.2',

  /*
   * THERE IS NO COMPLAINTS OR DISPUTES DATA IN THIS APPLICATION. No ticket,
   * dispute or report is recorded anywhere, so by default the complaints
   * component has no value and its 10% is renormalised across the components
   * that do - a seller is never scored on a metric that does not exist.
   *
   * Setting this to 'true' substitutes the share of 1-2 star reviews. That is
   * a proxy, not a measurement, and it partly restates the ratings component,
   * so it is off until someone decides that trade is worth making. When real
   * dispute records exist they slot into the same 10% and this goes away.
   */
  'complaints.useLowStarProxy': 'false'
};

var BADGE_CONFIG_CACHE_KEY = 'v1:badgeConfig';
var BADGE_CONFIG_CACHE_TTL_SECONDS = 300;

/** Defaults, overlaid with whatever the BadgeConfig tab sets. Never throws. */
function badgeConfig() {
  return getCached(BADGE_CONFIG_CACHE_KEY, BADGE_CONFIG_CACHE_TTL_SECONDS, function () {
    var cfg = {};
    Object.keys(BADGE_CONFIG_DEFAULTS).forEach(function (k) {
      cfg[k] = BADGE_CONFIG_DEFAULTS[k];
    });
    var rows;
    try {
      rows = sheetToObjects(getSheet('BadgeConfig'));
    } catch (err) {
      return cfg;          // tab absent - defaults are a working configuration
    }
    rows.forEach(function (r) {
      var key = String(r.Key || '').trim();
      // Only keys this build knows. A typo in the sheet must not invent a
      // setting that silently does nothing; it stays visible as an unknown key
      // in the admin view instead.
      if (key && Object.prototype.hasOwnProperty.call(BADGE_CONFIG_DEFAULTS, key)) {
        cfg[key] = String(r.Value);
      }
    });
    return cfg;
  });
}

function badgeNum(cfg, key) {
  var v = Number(cfg[key]);
  return isNaN(v) ? Number(BADGE_CONFIG_DEFAULTS[key]) : v;
}

function badgeFlag(cfg, key) {
  return String(cfg[key]) === 'true';
}

function badgeEnabled(cfg, id) {
  return badgeFlag(cfg, 'enabled.' + id);
}

/* ---------- metric gathering ------------------------------------------------
 *
 * One pass per sheet, indexed by OwnerId. Every one of these is called exactly
 * once per recompute, never per seller - the difference between four sheet
 * reads and four reads per store.
 */

/** Orders by owner: volume, fulfilment, cancellations, repeat customers, recency. */
function orderMetricsByOwner(cfg) {
  var rows;
  try {
    rows = sheetToObjects(getSheet('Orders'));
  } catch (err) {
    return {};
  }

  var windowMs = badgeNum(cfg, 'popular.windowDays') * 24 * 60 * 60 * 1000;
  var since = Date.now() - windowMs;
  var out = {};

  rows.forEach(function (o) {
    var id = String(o.OwnerId || '');
    if (!id) return;
    if (!out[id]) {
      out[id] = { total: 0, fulfilled: 0, cancelled: 0, recent: 0,
                  customers: {}, repeatCustomers: 0, distinctCustomers: 0 };
    }
    var m = out[id];
    m.total += 1;

    var status = String(o.Status || '');
    if (status === 'Fulfilled') m.fulfilled += 1;
    else if (status === 'Cancelled') m.cancelled += 1;

    var created = new Date(o.CreatedAt).getTime();
    // A cancelled order is interest that went nowhere; counting it as
    // "currently receiving strong customer interest" would reward churn.
    if (!isNaN(created) && created >= since && status !== 'Cancelled') m.recent += 1;

    var email = normalizeEmail(o.CustomerEmail);
    if (email && status !== 'Cancelled') m.customers[email] = (m.customers[email] || 0) + 1;
  });

  Object.keys(out).forEach(function (id) {
    var m = out[id];
    var emails = Object.keys(m.customers);
    m.distinctCustomers = emails.length;
    m.repeatCustomers = emails.filter(function (e) { return m.customers[e] >= 2; }).length;
    delete m.customers;    // addresses must never reach a response or the snapshot
  });
  return out;
}

/** Published reviews by owner: average, count, and the 1-2 star share. */
function reviewMetricsByOwner() {
  var rows;
  try {
    rows = sheetToObjects(getSheet('Reviews'));
  } catch (err) {
    return {};
  }
  var out = {};
  rows.forEach(function (r) {
    if (String(r.Status) !== 'published') return;
    var id = String(r.OwnerId || '');
    var rating = Number(r.Rating);
    if (!id || !(rating >= 1 && rating <= 5)) return;
    if (!out[id]) out[id] = { sum: 0, count: 0, low: 0 };
    out[id].sum += rating;
    out[id].count += 1;
    if (rating <= 2) out[id].low += 1;
  });
  Object.keys(out).forEach(function (id) {
    var m = out[id];
    m.average = Math.round((m.sum / m.count) * 10) / 10;
    m.lowShare = m.low / m.count;
    delete m.sum;
  });
  return out;
}

/**
 * How long a seller takes to answer, in minutes, as a MEDIAN.
 *
 * Median rather than mean on purpose: one holiday that left a message
 * unanswered for nine days would drag an otherwise prompt seller's mean past
 * any threshold, and "usually responds quickly" is a claim about the usual
 * case. The median is what that sentence actually promises.
 *
 * A reply is the first vendor message after a customer message in the same
 * conversation. Vendor messages that follow another vendor message are the same
 * reply continued, not a new one, so they are not counted again.
 *
 * Only the recent window counts. A seller who answered promptly last year and
 * ignores people now should lose the badge, which a lifetime median would hide.
 */
function responseMetricsByOwner(cfg) {
  var rows;
  try {
    rows = sheetToObjects(getSheet('Messages'));
  } catch (err) {
    return {};
  }

  var since = Date.now() - badgeNum(cfg, 'responsive.windowDays') * 24 * 60 * 60 * 1000;

  var byConversation = {};
  rows.forEach(function (m) {
    var cid = String(m.ConversationId || '');
    var ownerId = String(m.OwnerId || '');
    var at = new Date(m.CreatedAt).getTime();
    if (!cid || !ownerId || isNaN(at) || at < since) return;
    if (!byConversation[cid]) byConversation[cid] = [];
    byConversation[cid].push({ owner: ownerId, at: at, sender: String(m.SenderType || '') });
  });

  var waits = {};
  Object.keys(byConversation).forEach(function (cid) {
    var msgs = byConversation[cid].sort(function (a, b) { return a.at - b.at; });
    var askedAt = null;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].sender === 'customer') {
        // Only the FIRST unanswered question starts the clock. Someone sending
        // three messages in a row is waiting once, not three times.
        if (askedAt === null) askedAt = msgs[i].at;
      } else if (msgs[i].sender === 'vendor' && askedAt !== null) {
        var mins = (msgs[i].at - askedAt) / 60000;
        if (!waits[msgs[i].owner]) waits[msgs[i].owner] = [];
        waits[msgs[i].owner].push(mins);
        askedAt = null;
      }
    }
  });

  var out = {};
  Object.keys(waits).forEach(function (id) {
    var list = waits[id].sort(function (a, b) { return a - b; });
    var mid = Math.floor(list.length / 2);
    out[id] = {
      replies: list.length,
      medianMinutes: list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2)
    };
  });
  return out;
}

/* ---------- the score -------------------------------------------------------
 *
 * Six weighted components, each normalised to 0..1.
 *
 * A COMPONENT WITH NO DATA IS ABSENT, NOT ZERO, and the remaining weights are
 * renormalised over what is left. Scoring a seller zero for responsiveness
 * because nobody has messaged them yet would be a measurement of our data, not
 * of them - and it would make every new seller look like a bad one. A seller
 * with no scorable component at all gets null, which is not a low score and
 * never earns or loses a badge on its own.
 */
function sellerScore(cfg, om, rm, sm) {
  var parts = [];

  function add(weightKey, value) {
    if (value === null || value === undefined || isNaN(value)) return;
    parts.push({ w: badgeNum(cfg, weightKey), v: Math.max(0, Math.min(1, value)) });
  }

  // Ratings: 1 star is the floor of the scale, not half marks, so a 1.0 average
  // scores 0 rather than 0.2.
  if (rm && rm.count >= badgeNum(cfg, 'min.reviews')) {
    add('weight.ratings', (rm.average - 1) / 4);
  }

  if (om && om.total > 0) {
    add('weight.orders', om.fulfilled / badgeNum(cfg, 'target.orders'));
    // Orders that completed, out of every order taken - so a pile left sitting
    // in Paid counts against this as much as a cancellation does.
    add('weight.fulfilment', om.fulfilled / om.total);
    add('weight.cancellations', 1 - (om.cancelled / om.total));
  }

  if (sm && sm.replies >= badgeNum(cfg, 'responsive.minReplies')) {
    // Full marks up to half an hour, nothing left after a day.
    var best = 30, worst = 24 * 60;
    add('weight.responsiveness', (worst - sm.medianMinutes) / (worst - best));
  }

  if (badgeFlag(cfg, 'complaints.useLowStarProxy')
      && rm && rm.count >= badgeNum(cfg, 'min.reviews')) {
    add('weight.complaints', 1 - rm.lowShare);
  }

  var totalWeight = 0, sum = 0;
  parts.forEach(function (p) { totalWeight += p.w; sum += p.w * p.v; });
  if (totalWeight <= 0) return null;
  return Math.round((sum / totalWeight) * 100);
}

/* ---------- eligibility -----------------------------------------------------
 *
 * Each of these answers "does the data say yes", ignoring admin overrides and
 * ignoring whether the badge is switched on. Both of those are applied later,
 * on top, so the automated answer is always recorded even when an override
 * changes what is shown - which is what lets the admin view say "auto: no,
 * shown because an admin granted it".
 */
function autoBadgesFor(cfg, owner, score, om, rm, sm, popularOwnerIds) {
  var out = [];
  var why = {};
  var id = String(owner.OwnerId);

  var minOrders = badgeNum(cfg, 'min.orders');
  var minReviews = badgeNum(cfg, 'min.reviews');
  var enoughHistory = !!om && om.total >= minOrders;
  var enoughReviews = !!rm && rm.count >= minReviews;

  // New Seller. The only badge that needs no track record - it is a statement
  // about the join date and nothing else.
  var joined = new Date(owner.CreatedAt).getTime();
  // A blank CreatedAt means a seller who registered before that column existed,
  // not one who joined at the epoch. Treated as "not new", or every long-
  // standing store on the site would suddenly be labelled brand new.
  if (!isNaN(joined) && joined > 0) {
    var ageDays = (Date.now() - joined) / (24 * 60 * 60 * 1000);
    if (ageDays <= badgeNum(cfg, 'newSellerDays')) {
      out.push('new');
      why.new = 'Joined ' + Math.max(0, Math.round(ageDays)) + ' days ago';
    }
  }

  if (sm && sm.replies >= badgeNum(cfg, 'responsive.minReplies')
      && sm.medianMinutes <= badgeNum(cfg, 'responsive.maxMedianMinutes')) {
    out.push('responsive');
    why.responsive = 'Median reply ' + Math.round(sm.medianMinutes) + ' min over '
      + sm.replies + ' replies';
  }

  if (om && om.total >= badgeNum(cfg, 'delivery.minOrders')) {
    var rate = om.fulfilled / om.total;
    if (rate >= badgeNum(cfg, 'delivery.minFulfilRate')) {
      out.push('delivery');
      why.delivery = Math.round(rate * 100) + '% of ' + om.total + ' orders fulfilled';
    }
  }

  if (om && om.total >= badgeNum(cfg, 'favourite.minOrders')
      && om.distinctCustomers > 0 && enoughReviews) {
    var repeat = om.repeatCustomers / om.distinctCustomers;
    if (repeat >= badgeNum(cfg, 'favourite.minRepeatRate')
        && rm.average >= badgeNum(cfg, 'favourite.minRating')) {
      out.push('favourite');
      why.favourite = Math.round(repeat * 100) + '% of ' + om.distinctCustomers
        + ' customers came back, ' + rm.average.toFixed(1) + ' average';
    }
  }

  if (popularOwnerIds[id]) {
    out.push('popular');
    why.popular = (om ? om.recent : 0) + ' orders in the last '
      + badgeNum(cfg, 'popular.windowDays') + ' days';
  }

  // Top Seller and Mwakete Recommended both need a real track record AND a real
  // score. Either floor alone is gameable: a perfect ratio over two orders, or
  // a mountain of orders with a poor one.
  if (score !== null && enoughHistory && enoughReviews) {
    if (score >= badgeNum(cfg, 'top.score') && rm.average >= badgeNum(cfg, 'top.minRating')) {
      out.push('top');
      why.top = 'Score ' + score + ', ' + rm.average.toFixed(1) + ' average over '
        + rm.count + ' reviews';
    }
    if (score >= badgeNum(cfg, 'recommended.score')
        && rm.average >= badgeNum(cfg, 'recommended.minRating')
        && om.total >= badgeNum(cfg, 'recommended.minOrders')) {
      out.push('recommended');
      why.recommended = 'Score ' + score + ', ' + rm.average.toFixed(1) + ' average, '
        + om.total + ' orders';
    }
  }

  // Verified is deliberately absent. It is a statement that a human checked
  // this store, and no amount of good data is a substitute for that, so it has
  // no automatic path at all - only an admin can grant it.

  return { badges: out, why: why };
}

/**
 * Which stores count as busy right now: the top slice by recent orders, above a
 * floor.
 *
 * Relative, because "currently receiving strong customer interest" is a
 * comparison. An absolute threshold on a marketplace this size would either
 * badge everyone in a good month or nobody in a quiet one, and would say more
 * about the season than about the seller.
 */
function popularOwnerSet(cfg, orderMetrics) {
  var floor = badgeNum(cfg, 'popular.minRecentOrders');
  var ranked = Object.keys(orderMetrics)
    .filter(function (id) { return orderMetrics[id].recent >= floor; })
    .sort(function (a, b) { return orderMetrics[b].recent - orderMetrics[a].recent; });

  var take = Math.floor(ranked.length * badgeNum(cfg, 'popular.topFraction'));
  // At least one, so a marketplace with three qualifying stores still names its
  // busiest rather than rounding down to nobody.
  if (ranked.length > 0 && take < 1) take = 1;

  var set = {};
  ranked.slice(0, take).forEach(function (id) { set[id] = true; });
  return set;
}

/* ---------- overrides -------------------------------------------------------
 *
 * An override changes what is SHOWN. It never changes what the data said - that
 * is recorded either way, so the admin view can show "auto: not eligible,
 * shown: granted by an admin" rather than one merged answer that hides which
 * is which.
 */
function applyBadgeOverrides(cfg, owner, auto) {
  var effective = [];
  var source = {};

  // One switch that takes every badge off a store, for a seller under review.
  // Checked first, so nothing below can put one back.
  if (String(owner.BadgeSuppressed) === 'true') {
    return { badges: [], source: {}, suppressed: true };
  }

  auto.forEach(function (id) {
    if (!badgeEnabled(cfg, id)) return;             // switched off site-wide
    if (id === 'recommended' && String(owner.BadgeRecommended) === 'false') return;
    effective.push(id);
    source[id] = 'auto';
  });

  if (badgeEnabled(cfg, 'verified') && String(owner.BadgeVerified) === 'true'
      && effective.indexOf('verified') === -1) {
    effective.push('verified');
    source.verified = 'admin';
  }

  if (badgeEnabled(cfg, 'recommended') && String(owner.BadgeRecommended) === 'true'
      && effective.indexOf('recommended') === -1) {
    effective.push('recommended');
    source.recommended = 'admin';
  }

  // Priority order, so every surface gets them in the same order without
  // sorting again.
  var ordered = BADGE_IDS.filter(function (id) { return effective.indexOf(id) !== -1; });
  return { badges: ordered, source: source, suppressed: false };
}

/* ---------- the recompute ---------------------------------------------------
 *
 * Four full sheet reads, once. Run it from the Apps Script editor to seed the
 * snapshot, from a time-driven trigger to keep it current, or from the admin
 * page after verifying a seller.
 */
function computeSellerBadgeSnapshots() {
  var cfg = badgeConfig();
  var owners = sheetToObjects(getSheet('Owners'));
  var orderMetrics = orderMetricsByOwner(cfg);
  var reviewMetrics = reviewMetricsByOwner();
  var responseMetrics = responseMetricsByOwner(cfg);
  var popular = popularOwnerSet(cfg, orderMetrics);

  return owners.map(function (owner) {
    var id = String(owner.OwnerId);
    var om = orderMetrics[id] || null;
    var rm = reviewMetrics[id] || null;
    var sm = responseMetrics[id] || null;

    var score = sellerScore(cfg, om, rm, sm);
    var auto = autoBadgesFor(cfg, owner, score, om, rm, sm, popular);
    var applied = applyBadgeOverrides(cfg, owner, auto.badges);

    return {
      ownerId: id,
      badges: applied.badges,
      score: score,
      // Admin-only. None of this reaches a customer response - see
      // sellerBadgeIndex, which reads the Badges column and nothing else.
      metrics: {
        orders: om ? om.total : 0,
        fulfilled: om ? om.fulfilled : 0,
        cancelled: om ? om.cancelled : 0,
        recentOrders: om ? om.recent : 0,
        customers: om ? om.distinctCustomers : 0,
        repeatCustomers: om ? om.repeatCustomers : 0,
        reviews: rm ? rm.count : 0,
        rating: rm ? rm.average : null,
        replies: sm ? sm.replies : 0,
        medianReplyMinutes: sm ? Math.round(sm.medianMinutes) : null
      },
      reason: {
        auto: auto.badges,
        why: auto.why,
        source: applied.source,
        suppressed: applied.suppressed
      }
    };
  });
}

var SELLER_BADGE_CACHE_KEY = 'v1:sellerBadges';
var SELLER_BADGE_CACHE_TTL_SECONDS = 600;

/**
 * Writes the snapshot and drops the caches that serve it.
 *
 * One row per seller, rewritten in place. Badges are never accumulated: a
 * seller who no longer qualifies simply is not in the new list, which is what
 * makes losing a badge work without any separate removal path. Nothing is
 * permanent, and a seller whose performance recovers is awarded it again on the
 * next run.
 */
function recomputeSellerBadges() {
  ensureBadgeColumns();
  var snapshots = computeSellerBadgeSnapshots();
  var sheet = getSheet('SellerBadges');
  var now = nowIso();

  /*
   * ONE WRITE FOR THE WHOLE TAB, not one per seller.
   *
   * Row-at-a-time was the obvious shape and it does not scale: a marketplace of
   * 200 sellers meant 200 separate setValues round trips inside a trigger that
   * Apps Script kills at six minutes. This is a derived tab - nothing but this
   * function writes it, and every row is rebuilt from scratch on every run - so
   * there is nothing to preserve and no reason to seek to individual rows.
   *
   * Addressed by header NAME, not column position, so reordering the tab in the
   * Sheet UI cannot silently write scores into the badges column.
   */
  var headers = getHeaders(sheet).map(function (h) { return String(h); });
  var values = snapshots.map(function (s) {
    var record = {
      OwnerId: s.ownerId,
      Badges: s.badges.join(','),
      Score: s.score === null ? '' : s.score,
      MetricsJson: JSON.stringify(s.metrics),
      ReasonJson: JSON.stringify(s.reason),
      UpdatedAt: now
    };
    // Through the same guard every other write in this app goes through, so a
    // value that happened to start with = or + could never become a formula in
    // whoever's spreadsheet this is.
    return headers.map(function (h) {
      return Object.prototype.hasOwnProperty.call(record, h)
        ? sanitizeForSheetCell(record[h]) : '';
    });
  });

  // Built first, then swapped, so the window where the tab is empty is
  // milliseconds. If the script died in that window the worst case is a site
  // with no badges until the next run - decoration missing, nothing broken.
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, headers.length).clearContent();
  if (values.length) sheet.getRange(2, 1, values.length, headers.length).setValues(values);

  invalidateCache([SELLER_BADGE_CACHE_KEY, BADGE_CONFIG_CACHE_KEY]);
  Logger.log('recomputeSellerBadges: ' + snapshots.length + ' sellers updated');
  return snapshots.length;
}

/** Adds the three override columns if this sheet predates them. */
function ensureBadgeColumns() {
  var sheet = getSheet('Owners');
  ensureColumn(sheet, 'BadgeVerified');
  ensureColumn(sheet, 'BadgeRecommended');
  ensureColumn(sheet, 'BadgeSuppressed');
}

/**
 * THE READ PATH. {ownerId: ['recommended','verified']} from the snapshot tab.
 *
 * One sheet read per cache period for the whole site, and only the Badges
 * column is used - scores, metrics and reasons stay where an admin can see them
 * and a customer response can never carry them by accident.
 *
 * Returns {} on any failure. Badges are decoration on a working marketplace; a
 * missing tab, a bad row or a cache miss during a Sheets hiccup must cost a
 * shopper nothing more than a page without badges.
 */
function sellerBadgeIndex() {
  return getCached(SELLER_BADGE_CACHE_KEY, SELLER_BADGE_CACHE_TTL_SECONDS, function () {
    var rows;
    try {
      rows = sheetToObjects(getSheet('SellerBadges'));
    } catch (err) {
      return {};
    }
    var index = {};
    rows.forEach(function (r) {
      var id = String(r.OwnerId || '');
      if (!id) return;
      var ids = String(r.Badges || '').split(',')
        .map(function (s) { return s.trim(); })
        // Filtered against BADGE_IDS, so a hand-edited cell cannot put an
        // arbitrary string into a customer response.
        .filter(function (s) { return BADGE_IDS.indexOf(s) !== -1; });
      if (ids.length) index[id] = ids;
    });
    return index;
  });
}

/**
 * Installs the hourly recompute. Run once from the editor.
 *
 * Deliberately not reachable from doGet/doPost: the web app is unauthenticated,
 * and an endpoint that can create triggers must not be on the internet. Removes
 * any previous copy first, so running it twice leaves one trigger rather than
 * two doing the same work.
 */
function installBadgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'recomputeSellerBadges') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('recomputeSellerBadges').timeBased().everyHours(6).create();
  Logger.log('Badge recompute scheduled every 6 hours.');
}
