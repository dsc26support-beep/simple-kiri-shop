/**
 * Smart notification engine (CESN Stage 4-6). One dispatcher,
 * emitEngagementEvent, that every automatic trigger (PriceWatch.gs) and every
 * seller campaign (SellerEngagement.gs, Stage 7) funnels through, so audience
 * eligibility, frequency caps, de-duplication and audit are enforced in ONE
 * place and cannot be bypassed.
 *
 * Channels: in-app Notification Centre (always) + Web Push (Push.gs, only if
 * the owner configured it). Email stays the existing MarketingEngine.gs's job.
 *
 * All limits are admin-configurable Script Properties (Stage 8 exposes a UI);
 * nothing is hard-coded through the app. The whole engine only does anything
 * once the owner adds a time trigger for runEngagementSweep (PriceWatch.gs) or
 * a seller sends a campaign - and then only to customers who follow/like (with
 * notifications on) or gave this store marketing consent.
 */

var CESN_DEFAULTS = {
  CESN_ENABLED: 'true',          // master switch for engagement notifications
  CESN_MAX_PER_DAY: '3',         // promotional notifications per customer per day
  CESN_MAX_PER_WEEK: '10',       // ... per week
  CESN_MIN_INTERVAL_MIN: '30',   // minimum minutes between notifications to one customer
  CESN_PRICE_DROP_PCT: '10',     // the drop that triggers a price-drop notification
  CESN_PRICE_DWELL_HOURS: '12',  // the previous price must have stood this long (anti-inflation)
  CESN_CATEGORIES_OFF: ''        // comma-separated category keys to disable platform-wide
};

// The eleven categories, each with its audience policy. audience:
//   engaged     = followers OR likers, with that store's notifications on
//   followers   = followers only (with notifications on) - a follower perk
//   subscribers = gave this store marketing consent
//   both        = engaged OR subscribers
var CESN_CATEGORIES = {
  price_drop:         { label: 'Price drop',         auto: true,  audience: 'engaged' },
  new_arrival:        { label: 'New arrival',        auto: true,  audience: 'engaged' },
  back_in_stock:      { label: 'Back in stock',      auto: true,  audience: 'engaged' },
  popular_product:    { label: 'Popular product',    auto: false, audience: 'engaged' },
  store_announcement: { label: 'Store announcement', auto: false, audience: 'engaged' },
  flash_sale:         { label: 'Flash sale',         auto: false, audience: 'subscribers' },
  exclusive_discount: { label: 'Exclusive discount', auto: false, audience: 'followers' },
  bundle_deal:        { label: 'Bundle deal',        auto: false, audience: 'subscribers' },
  seasonal:           { label: 'Seasonal',           auto: false, audience: 'subscribers' },
  loyalty_reward:     { label: 'Loyalty & rewards',  auto: false, audience: 'subscribers' },
  manual_promo:       { label: 'Promotion',          auto: false, audience: 'both' }
};

function cesnConfig() {
  var p = PropertiesService.getScriptProperties();
  var get = function (k) { var v = p.getProperty(k); return (v === null || v === undefined || v === '') ? CESN_DEFAULTS[k] : v; };
  // Honour an explicit 0 (e.g. "no minimum interval") - never coerce it to the
  // default the way `parseInt(...) || default` would, since 0 is falsy.
  var num = function (k, parse) { var n = parse(get(k)); return isNaN(n) ? parse(CESN_DEFAULTS[k]) : n; };
  var int = function (k) { return num(k, function (v) { return parseInt(v, 10); }); };
  var flt = function (k) { return num(k, function (v) { return parseFloat(v); }); };
  return {
    enabled: String(get('CESN_ENABLED')) === 'true',
    maxPerDay: int('CESN_MAX_PER_DAY'),
    maxPerWeek: int('CESN_MAX_PER_WEEK'),
    minIntervalMin: int('CESN_MIN_INTERVAL_MIN'),
    dropPct: flt('CESN_PRICE_DROP_PCT'),
    dwellHours: flt('CESN_PRICE_DWELL_HOURS'),
    disabled: String(get('CESN_CATEGORIES_OFF') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  };
}

function cesnCategoryEnabled(key, cfg) {
  return !!CESN_CATEGORIES[key] && cfg.disabled.indexOf(key) === -1;
}

// Resolve the eligible, de-duplicated customer ids for a store + audience type.
function cesnAudienceFor(storeSlug, audienceType) {
  var engagedOf = function (sheetName) {
    return sheetToObjects(getSheet(sheetName)).filter(function (r) {
      return String(r.StoreSlug) === String(storeSlug) && String(r.Status) === 'active' && String(r.NotifyOn) !== 'false';
    }).map(function (r) { return String(r.CustomerId); });
  };
  var subsOf = function () {
    return sheetToObjects(getSheet('StoreMarketingConsents')).filter(function (r) {
      return String(r.StoreSlug) === String(storeSlug) && String(r.Status) === 'active';
    }).map(function (r) { return String(r.CustomerId); });
  };
  var set = {};
  var add = function (arr) { arr.forEach(function (c) { set[c] = true; }); };
  if (audienceType === 'followers') add(engagedOf('StoreFollows'));
  else if (audienceType === 'subscribers') add(subsOf());
  else if (audienceType === 'engaged') { add(engagedOf('StoreFollows')); add(engagedOf('StoreLikes')); }
  else { add(engagedOf('StoreFollows')); add(engagedOf('StoreLikes')); add(subsOf()); } // both
  return Object.keys(set);
}

function cesnNotifsForCustomer_(customerId) {
  return sheetToObjects(getSheet('Notifications')).filter(function (r) { return String(r.CustomerId) === String(customerId); });
}

// Has this customer already received this exact event?
function cesnHasSourceKey_(rows, sourceKey) {
  if (!sourceKey) return false;
  return rows.some(function (r) { return String(r.SourceKey) === String(sourceKey); });
}

// Platform frequency protection (shared by automatic + manual). Returns true if
// one more notification is allowed for this customer right now.
function cesnFrequencyAllows_(rows, cfg, nowMs) {
  var times = rows.map(function (r) { return new Date(r.CreatedAt).getTime(); }).filter(function (t) { return !isNaN(t); });
  if (times.filter(function (t) { return nowMs - t < 86400000; }).length >= cfg.maxPerDay) return false;
  if (times.filter(function (t) { return nowMs - t < 7 * 86400000; }).length >= cfg.maxPerWeek) return false;
  var last = times.length ? Math.max.apply(null, times) : 0;
  if (last && (nowMs - last) < cfg.minIntervalMin * 60000) return false;
  return true;
}

/**
 * Deliver one event to its eligible audience. event:
 *   { storeSlug, category, title, body, deepLink?, imageUrl?, sourceKey, campaignId? }
 * Returns { queued, skippedFreq, skippedDup, audience, reason? }. Writes one
 * CesnAudit row. Enforces: master switch, per-category toggle, audience
 * eligibility, de-dup by sourceKey, and the shared frequency caps - a seller
 * can never reach a customer who is not in the eligible audience.
 */
function emitEngagementEvent(event) {
  event = event || {};
  var cfg = cesnConfig();
  var cat = event.category;
  var result = { queued: 0, skippedFreq: 0, skippedDup: 0, audience: 0 };
  if (!cfg.enabled) { result.reason = 'disabled'; cesnAudit_(event, 'n/a', result); return result; }
  if (!cesnCategoryEnabled(cat, cfg)) { result.reason = 'category-off'; cesnAudit_(event, 'n/a', result); return result; }

  var audienceType = CESN_CATEGORIES[cat].audience;
  var customers = cesnAudienceFor(event.storeSlug, audienceType);
  result.audience = customers.length;
  var nowMs = Date.now();
  customers.forEach(function (cid) {
    var rows = cesnNotifsForCustomer_(cid);
    if (cesnHasSourceKey_(rows, event.sourceKey)) { result.skippedDup++; return; }
    if (!cesnFrequencyAllows_(rows, cfg, nowMs)) { result.skippedFreq++; return; }
    var note = {
      storeSlug: event.storeSlug, category: cat, title: event.title || '', body: event.body || '',
      imageUrl: event.imageUrl || '', deepLink: event.deepLink || '', campaignId: event.campaignId || '',
      sourceKey: event.sourceKey || ''
    };
    appendNotification_(cid, note);                                    // in-app (Engagement.gs)
    if (typeof maybePushNotification_ === 'function') maybePushNotification_(cid, note); // push (Push.gs), dormant unless configured
    result.queued++;
  });
  cesnAudit_(event, audienceType, result);
  return result;
}

function cesnAudit_(event, audienceType, result) {
  try {
    appendRowFromObject(getSheet('CesnAudit'), {
      EventId: newId('cesn'), StoreSlug: event.storeSlug || '', Category: event.category || '',
      SourceKey: event.sourceKey || '', Audience: audienceType,
      Queued: result.queued, SkippedFreq: result.skippedFreq, SkippedDup: result.skippedDup, CreatedAt: nowIso()
    });
  } catch (e) { /* audit is best-effort, never blocks delivery */ }
}
