/**
 * Mwakete Marketing Engine - audience, interest, campaign generation, queue
 * and the scheduled sweep. Settings, consent, template and actions: see
 * Marketing.gs.
 *
 *   runMarketingSweep()                 its OWN hourly trigger, not the
 *     -> generateMarketingOpportunities   reminder sweep's: a marketing run
 *     -> processMarketingQueue            that is slow or fails cannot delay
 *                                         an abandoned-cart reminder or a
 *                                         session cleanup.
 *
 * WHERE INTEREST COMES FROM - only what Mwakete already holds for running
 * the shop: Orders and Bookings (matched by the customer's verified email),
 * Reviews (CustomerId) and AbandonedCarts (email). Product views and store
 * visits are anonymous counters with no customer attached, and Recent Views
 * never leaves the phone, so neither is - or can be - used per customer. The
 * anonymous Products.Views count is used only to know what is popular.
 *
 * WHY NOTHING SENDS TWICE
 *   - every (campaign, customer) gets exactly one DELIVERY row in
 *     CampaignEvents, claimed under the script lock before the email goes out
 *     and re-checked inside that lock;
 *   - automatic campaigns are keyed by SourceKey (e.g. NEW_PRODUCTS:2026-W41),
 *     so a second run in the same week finds the campaign already made;
 *   - one sweep at a time (MARKETING_SWEEP_LOCK below);
 *   - a customer gets at most MARKETING_MAX_PER_WINDOW promotional emails per
 *     MARKETING_FREQUENCY_DAYS, across all campaigns.
 */

var MARKETING_WEIGHTS = {
  ORDER_COMPLETED: 6, ORDER_CREATED: 3, BOOKING: 3, CART_ABANDONED: 4, REVIEW: 3
};
/** Days -> multiplier: recent behaviour counts fully, old behaviour fades, >90 days is ignored. */
function marketingDecay(ageDays) {
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.6;
  if (ageDays <= 90) return 0.25;
  return 0;
}
var MARKETING_INTEREST_MIN = 3;              // e.g. one recent order
var MARKETING_INACTIVE_REPEAT_DAYS = 60;     // a lapsed customer is asked again at most this often
var MARKETING_MAX_CAMPAIGNS_PER_RUN = 3;
var MARKETING_RUN_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops a run at 6 minutes
var MARKETING_SWEEP_LOCK_KEY = 'MARKETING_SWEEP_LOCK';
var MARKETING_SWEEP_LOCK_STALE_MS = 15 * 60 * 1000;

var DAY_MS = 86400000;

function isoWeekKey(d) {
  var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  var day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  var week = Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
  return t.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
}
function monthKey(d) { return d.toISOString().slice(0, 7); }
function msOf(v) { var t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }
function lc(s) { return String(s || '').trim().toLowerCase(); }

/* ---------------------------------------------------------------------------
 * Context: every table read once per run
 * ------------------------------------------------------------------------- */

function buildMarketingContext(cfg, now) {
  var owners = sheetToObjects(getSheet('Owners')).filter(function (o) { return isStoreBrowsable(o); });
  var ownerById = {}, ownerBySlug = {};
  owners.forEach(function (o) { ownerById[o.OwnerId] = o; ownerBySlug[o.StoreSlug] = o; });

  var products = sheetToObjects(getSheet('Products')).filter(function (p) {
    return p.Status === 'active' && ownerById[p.OwnerId];
  });
  var productById = {};
  products.forEach(function (p) { productById[p.ProductId] = p; });
  var allProductCategory = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { allProductCategory[p.ProductId] = String(p.Category || ''); });
  var variantProduct = {};
  sheetToObjects(getSheet('Variants')).forEach(function (v) { variantProduct[v.VariantId] = v.ProductId; });

  var customers = sheetToObjects(getSheet('Customers')).filter(function (c) {
    return c.CustomerId && String(c.EmailVerified) === 'true' && /@/.test(String(c.Email || ''));
  });
  var prefs = {};
  sheetToObjects(getSheet('MarketingPreferences')).forEach(function (p) { prefs[String(p.CustomerId)] = p; });

  // Interest per customer, keyed by email (orders/bookings/carts) and id (reviews).
  var byEmail = {};
  customers.forEach(function (c) {
    byEmail[lc(c.Email)] = { stores: {}, categories: {}, ordered: {}, lastActivityAt: 0, fulfilled: 0, cartItems: [] };
  });
  var idToEmail = {};
  customers.forEach(function (c) { idToEmail[c.CustomerId] = lc(c.Email); });

  function add(email, weight, at, storeSlug, productIds) {
    var it = byEmail[email];
    if (!it || !at) return;
    var f = weight * marketingDecay((now - at) / DAY_MS);
    if (at > it.lastActivityAt) it.lastActivityAt = at;
    if (!f) return;
    if (storeSlug) it.stores[storeSlug] = (it.stores[storeSlug] || 0) + f;
    (productIds || []).forEach(function (pid) {
      var cat = allProductCategory[pid];
      if (cat) it.categories[cat] = (it.categories[cat] || 0) + f;
    });
  }

  var orders = sheetToObjects(getSheet('Orders'));
  orders.forEach(function (o) {
    var email = lc(o.CustomerEmail);
    if (!byEmail[email] || o.Status === 'Cancelled') return;
    var pids = [];
    try { pids = (JSON.parse(o.ItemsJson || '[]') || []).map(function (i) { return String(i.productId || ''); }).filter(Boolean); } catch (e) { pids = []; }
    pids.forEach(function (pid) { byEmail[email].ordered[pid] = true; });
    var done = o.Status === 'Fulfilled';
    if (done) byEmail[email].fulfilled++;
    add(email, done ? MARKETING_WEIGHTS.ORDER_COMPLETED : MARKETING_WEIGHTS.ORDER_CREATED, msOf(o.CreatedAt), o.StoreSlug, pids);
  });
  sheetToObjects(getSheet('Bookings')).forEach(function (b) {
    if (b.Status === 'Cancelled' || b.Status === 'Declined') return;
    add(lc(b.CustomerEmail), MARKETING_WEIGHTS.BOOKING, msOf(b.CreatedAt), b.StoreSlug, [String(b.ProductId || '')]);
  });
  sheetToObjects(getSheet('Reviews')).forEach(function (r) {
    if (r.Status === 'hidden' || r.Status === 'removed') return;
    add(idToEmail[r.CustomerId], MARKETING_WEIGHTS.REVIEW, msOf(r.CreatedAt), r.StoreSlug, [String(r.ProductId || '')]);
  });
  sheetToObjects(getSheet('AbandonedCarts')).forEach(function (r) {
    var email = lc(r.Email);
    if (!byEmail[email] || r.ConvertedOrderId) return;
    var items = [];
    try { items = JSON.parse(r.CartJson || '[]') || []; } catch (e) { items = []; }
    var pids = items.map(function (i) { return variantProduct[i.variantId] === i.productId ? String(i.productId) : ''; }).filter(Boolean);
    add(email, MARKETING_WEIGHTS.CART_ABANDONED, msOf(r.CreatedAt), r.StoreSlug, pids);
    byEmail[email].cartItems.push({ productIds: pids, storeSlug: r.StoreSlug, remindedAt: msOf(r.Reminded) });
  });

  var newest = products.slice().sort(function (a, b) { return msOf(b.CreatedAt) - msOf(a.CreatedAt); });
  var popular = products.filter(function (p) { return (Number(p.Views) || 0) > 0; })
    .sort(function (a, b) { return (Number(b.Views) || 0) - (Number(a.Views) || 0); }).slice(0, 20);

  var events = sheetToObjects(getSheet('CampaignEvents'));
  var campaigns = sheetToObjects(getSheet('Campaigns'));
  var campaignType = {};
  campaigns.forEach(function (c) { campaignType[c.CampaignId] = c.Type; });
  var sentAtByCustomer = {};
  var lastInactiveAt = {};
  events.forEach(function (e) {
    if (e.EventType !== 'DELIVERY' || e.Status !== 'SENT') return;
    var t = msOf(e.SentAt);
    (sentAtByCustomer[e.CustomerId] = sentAtByCustomer[e.CustomerId] || []).push(t);
    if (campaignType[e.CampaignId] === 'INACTIVE_CUSTOMER') lastInactiveAt[e.CustomerId] = Math.max(lastInactiveAt[e.CustomerId] || 0, t);
  });

  return {
    now: now, cfg: cfg, owners: owners, ownerById: ownerById, ownerBySlug: ownerBySlug,
    products: products, productById: productById, newest: newest, popular: popular,
    customers: customers, prefs: prefs, interest: byEmail, orders: orders,
    events: events, campaigns: campaigns, sentAtByCustomer: sentAtByCustomer, lastInactiveAt: lastInactiveAt
  };
}

function topKeys(scores, min) {
  return Object.keys(scores).filter(function (k) { return scores[k] >= (min || 0); })
    .sort(function (a, b) { return scores[b] - scores[a]; });
}

/** Up to n products from pool, those in the customer's categories first, never one they already ordered. */
function pickProductsFor(it, pool, n) {
  var cats = topKeys(it.categories, 0);
  var fresh = pool.filter(function (p) { return !it.ordered[p.ProductId]; });
  var liked = fresh.filter(function (p) { return cats.indexOf(String(p.Category)) !== -1; });
  var rest = fresh.filter(function (p) { return cats.indexOf(String(p.Category)) === -1; });
  return liked.concat(rest).slice(0, n);
}

/* ---------------------------------------------------------------------------
 * Who a campaign goes to, and why
 * ------------------------------------------------------------------------- */

/**
 * Returns { recipients: [{ customer, pref, reason, products: [...], storeSlug }],
 *           alreadyHandled }. Server-side only - never sent to a browser.
 */
function planCampaignRecipients(c, ctx, cfg) {
  var handled = {};
  ctx.events.forEach(function (e) {
    if (e.CampaignId !== c.CampaignId || e.EventType !== 'DELIVERY') return;
    // A dry-run row stops a second dry run, but not the real send later.
    if (e.Status === 'DRY_RUN' && !cfg.dryRun) return;
    handled[e.CustomerId] = true;
  });
  var stores = parseJsonArray(c.StoreSlugsJson);
  var chosen = parseJsonArray(c.ProductIdsJson).map(function (id) { return ctx.productById[id]; }).filter(Boolean);
  var filter = {};
  try { filter = JSON.parse(c.AudienceFilterJson || '{}') || {}; } catch (e) { filter = {}; }
  var sinceWeek = ctx.now - 7 * DAY_MS;
  var since30 = ctx.now - 30 * DAY_MS;

  var out = [];
  var alreadyHandled = 0;
  ctx.customers.forEach(function (cust) {
    var pref = ctx.prefs[cust.CustomerId];
    if (!isOptedIn(pref)) return;
    if (handled[cust.CustomerId]) { alreadyHandled++; return; }
    var it = ctx.interest[lc(cust.Email)];
    if (!it) return;
    var r = null;
    switch (c.Type) {
      case 'PRODUCT_INTEREST': {
        // A cart whose ONE reminder (Reminders.gs) went out 3-30 days ago,
        // never ordered, and the item still listed.
        var cart = it.cartItems.filter(function (ci) {
          return ci.remindedAt && ci.remindedAt <= ctx.now - 3 * DAY_MS && ci.remindedAt >= since30;
        })[0];
        var p = cart && cart.productIds.map(function (id) { return ctx.productById[id]; })
          .filter(function (x) { return x && !it.ordered[x.ProductId]; })[0];
        if (p) r = { reason: 'Left it in a cart after the reminder; still listed; not ordered', products: [p], storeSlug: p.StoreSlug };
        break;
      }
      case 'STORE_UPDATE': {
        var slug = stores[0];
        if ((it.stores[slug] || 0) < MARKETING_INTEREST_MIN) break;
        var fresh = ctx.newest.filter(function (x) { return x.StoreSlug === slug && msOf(x.CreatedAt) >= sinceWeek && !it.ordered[x.ProductId]; }).slice(0, 4);
        if (fresh.length) r = { reason: 'Has ordered or booked from this store', products: fresh, storeSlug: slug };
        break;
      }
      case 'CATEGORY_TRENDING': {
        var cats = topKeys(it.categories, MARKETING_INTEREST_MIN);
        var trend = ctx.popular.filter(function (x) { return cats.indexOf(String(x.Category)) !== -1 && !it.ordered[x.ProductId]; }).slice(0, 4);
        if (trend.length) r = { reason: 'Popular listings in a category they have ordered from', products: trend };
        break;
      }
      case 'NEW_PRODUCTS': {
        var pool = ctx.newest.filter(function (x) { return msOf(x.CreatedAt) >= sinceWeek; });
        var picks = pickProductsFor(it, pool, 4);
        if (picks.length) r = { reason: 'Opted in to news; new listings this week', products: picks };
        break;
      }
      case 'INACTIVE_CUSTOMER': {
        var lastSeen = it.lastActivityAt || msOf(cust.CreatedAt);
        if (lastSeen > ctx.now - cfg.inactiveDays * DAY_MS) break;
        if ((ctx.lastInactiveAt[cust.CustomerId] || 0) > ctx.now - MARKETING_INACTIVE_REPEAT_DAYS * DAY_MS) break;
        var lapsed = pickProductsFor(it, ctx.newest.filter(function (x) { return msOf(x.CreatedAt) >= since30; }), 4);
        if (lapsed.length) r = { reason: 'No orders or bookings for ' + cfg.inactiveDays + '+ days; new listings since', products: lapsed };
        break;
      }
      case 'RETURNING_CUSTOMER': {
        if (it.fulfilled < 1) break;
        var known = topKeys(it.stores, 0);
        var pool2 = ctx.newest.filter(function (x) {
          return msOf(x.CreatedAt) >= since30 && (known.indexOf(x.StoreSlug) !== -1 || it.categories[String(x.Category)] > 0);
        });
        var recs = pickProductsFor(it, pool2, 4);
        if (recs.length) r = { reason: 'Has a completed order; new listings from their stores or categories', products: recs };
        break;
      }
      case 'SELLER_PROMOTION':
      case 'SEASONAL': {
        var aud = c.AudienceType;
        if (aud === 'STORE_CUSTOMERS' && !((it.stores[stores[0]] || 0) > 0)) break;
        if (aud === 'CATEGORY_INTEREST' && !((it.categories[filter.category] || 0) > 0)) break;
        r = { reason: aud === 'STORE_CUSTOMERS' ? 'Has ordered or booked from this store'
          : aud === 'CATEGORY_INTEREST' ? 'Has ordered in this category' : 'Opted in to news',
          products: chosen, storeSlug: stores[0] || '' };
        break;
      }
    }
    if (r) { r.customer = cust; r.pref = pref; out.push(r); }
  });
  var max = Number(c.MaxRecipients) || 0;
  return { recipients: max ? out.slice(0, Math.max(0, max - alreadyHandled)) : out, alreadyHandled: alreadyHandled };
}

/* ---------------------------------------------------------------------------
 * One email for one recipient
 * ------------------------------------------------------------------------- */

var LISTING_WORD = { rental: 'Rental', service: 'Service' };

function marketingLink(base, path, campaignId, eventId) {
  if (!base) return '';
  return base + '/' + path + (path.indexOf('?') === -1 ? '?' : '&')
    + 'mc=' + encodeURIComponent(campaignId) + '&me=' + encodeURIComponent(eventId);
}

function composeCampaignEmail(c, r, ctx, cfg, eventId, unsubToken) {
  var base = cfg.siteBase;
  var store = r.storeSlug ? ctx.ownerBySlug[r.storeSlug] : null;
  var first = r.products[0];
  var firstStore = first ? ctx.ownerById[first.OwnerId] : null;
  var vars = {
    customerName: String(r.customer.Name || '').split(' ')[0] || 'there',
    storeName: store ? store.StoreName : (firstStore ? firstStore.StoreName : ''),
    productName: first ? first.Name : '',
    categoryName: first ? categoryLabelForEmail(first.Category) : '',
    productUrl: first ? marketingLink(base, 'product.html?store=' + encodeURIComponent(first.StoreSlug) + '&product=' + encodeURIComponent(first.ProductId), c.CampaignId, eventId) : '',
    storeUrl: store ? marketingLink(base, 'store.html?store=' + encodeURIComponent(store.StoreSlug), c.CampaignId, eventId) : ''
  };
  var manual = MANUAL_CAMPAIGN_TYPES.indexOf(c.Type) !== -1;
  var copy = manual
    ? { subject: fillMarketingVariables(c.Subject, vars), headline: fillMarketingVariables(c.Subject, vars),
        intro: fillMarketingVariables(c.BodyText, vars), cta: store ? 'Visit ' + store.StoreName : 'Visit Mwakete' }
    : generateCampaignCopy(c.Type, vars);
  var greeting = 'Hi ' + vars.customerName + ',\n\n';
  var items = r.products.map(function (p) {
    var o = ctx.ownerById[p.OwnerId] || {};
    var meta = [LISTING_WORD[p.ListingType], o.StoreName, storeLocationForEmail(o)].filter(Boolean).join(' · ');
    return {
      name: p.Name, meta: meta, imageUrl: p.ImageUrl,
      url: marketingLink(base, 'product.html?store=' + encodeURIComponent(p.StoreSlug) + '&product=' + encodeURIComponent(p.ProductId), c.CampaignId, eventId)
    };
  });
  var ctaUrl = c.Type === 'PRODUCT_INTEREST' ? vars.productUrl
    : store ? vars.storeUrl
    : marketingLink(base, 'categories.html', c.CampaignId, eventId);
  var rendered = renderMarketingEmail({
    base: base, headline: copy.headline, intro: greeting + copy.intro, items: items,
    ctaLabel: copy.cta, ctaUrl: ctaUrl,
    unsubscribeUrl: base ? base + '/unsubscribe.html?t=' + encodeURIComponent(unsubToken) : ''
  });
  // One line, bounded: names in a subject are seller-entered, and a line
  // break in a subject is how header injection starts.
  var subject = String(copy.subject || 'News from Mwakete').replace(/[\r\n\t]+/g, ' ').slice(0, 150);
  return { subject: subject, text: rendered.text, html: rendered.html };
}

function storeLocationForEmail(o) {
  var island = String(o.Island || ''), village = String(o.Village || '');
  if (/south tarawa/i.test(island) && village) return village;
  return island || village;
}

function categoryLabelForEmail(id) {
  var s = String(id || '').replace(/[-_]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------------------------
 * Generation: spot opportunities, create campaign records (never send here)
 * ------------------------------------------------------------------------- */

function generateMarketingOpportunities(cfg, now) {
  var ctx = buildMarketingContext(cfg, now);
  var d = new Date(now);
  var week = isoWeekKey(d), month = monthKey(d);
  var existing = {};
  ctx.campaigns.forEach(function (c) { if (c.SourceKey) existing[c.SourceKey] = true; });
  var created = [];
  var sheet = getSheet('Campaigns');

  // Drafts nobody approved in time are closed, not left to pile up.
  ctx.campaigns.forEach(function (c) {
    if (c.Status === 'DRAFT' && c.SourceKey && msOf(c.EndAt) && msOf(c.EndAt) < now) {
      updateRowFromObject(sheet, c.__row, { Status: 'CANCELLED', UpdatedAt: nowIso() });
    }
  });

  function make(type, key, name, extra, days) {
    if (existing[key]) return;
    var draft = Object.assign({
      CampaignId: newId('cmp'), Name: name, Type: type, Status: 'DRAFT', Objective: 'Automatic',
      AudienceType: 'AUTOMATIC', AudienceFilterJson: '{}', ProductIdsJson: '[]', StoreSlugsJson: '[]',
      BodyHtml: '', BodyText: '', CTAUrl: '', CTAType: '', StartAt: new Date(now).toISOString(),
      EndAt: new Date(now + (days || 7) * DAY_MS).toISOString(), CreatedAt: nowIso(), UpdatedAt: nowIso(),
      CreatedBy: 'engine', MaxRecipients: '', SentCount: 0, FailedCount: 0, LastRunAt: '', SourceKey: key
    }, extra || {});
    var copy = generateCampaignCopy(type, { storeName: extra && extra.__storeName });
    draft.Subject = copy.subject;
    draft.PreviewText = copy.intro.slice(0, 120);
    delete draft.__storeName;
    // Only worth creating if somebody would actually get it.
    if (!planCampaignRecipients(draft, ctx, cfg).recipients.length) return;
    draft.Status = cfg.autoApprove ? 'READY' : 'DRAFT';
    appendRowFromObject(sheet, draft);
    existing[key] = true;
    created.push({ campaignId: draft.CampaignId, type: type, name: name, status: draft.Status });
  }

  var newThisWeek = ctx.newest.filter(function (p) { return msOf(p.CreatedAt) >= now - 7 * DAY_MS; });
  if (newThisWeek.length >= 3) make('NEW_PRODUCTS', 'NEW_PRODUCTS:' + week, 'New on Mwakete ' + week);
  if (ctx.popular.length >= 3) make('CATEGORY_TRENDING', 'CATEGORY_TRENDING:' + week, 'Popular on Mwakete ' + week);
  make('PRODUCT_INTEREST', 'PRODUCT_INTEREST:' + week, 'Still interested? ' + week);
  make('INACTIVE_CUSTOMER', 'INACTIVE_CUSTOMER:' + month, 'What is new (lapsed customers) ' + month, null, 14);
  make('RETURNING_CUSTOMER', 'RETURNING_CUSTOMER:' + month, 'From your stores ' + month, null, 14);
  var storesWithNew = {};
  newThisWeek.forEach(function (p) { storesWithNew[p.StoreSlug] = true; });
  Object.keys(storesWithNew).forEach(function (slug) {
    var o = ctx.ownerBySlug[slug];
    if (!o) return;
    make('STORE_UPDATE', 'STORE_UPDATE:' + slug + ':' + week, 'New at ' + o.StoreName + ' ' + week,
      { StoreSlugsJson: JSON.stringify([slug]), __storeName: o.StoreName, CTAType: 'store' });
  });
  return created;
}

/* ---------------------------------------------------------------------------
 * Queue: claim, send, record - in small batches
 * ------------------------------------------------------------------------- */

function startOfUtcDay(now) { var d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }

/** How many more promotional emails this run may send, leaving transactional mail its share. */
function marketingSendAllowance(cfg, ctx) {
  var today = startOfUtcDay(ctx.now);
  var countToday = ctx.events.filter(function (e) {
    return e.EventType === 'DELIVERY' && (cfg.dryRun ? e.Status === 'DRY_RUN' : e.Status === 'SENT')
      && msOf(e.SentAt || e.CreatedAt) >= today;
  }).length;
  var allowance = Math.min(cfg.batchSize, Math.max(0, cfg.dailyLimit - countToday));
  // MailApp is the fallback for every email when Resend is not set up, so
  // marketing must never eat the quota login codes and orders depend on.
  if (!cfg.dryRun && !getResendConfig()) {
    var remaining = 0;
    try { remaining = MailApp.getRemainingDailyQuota(); } catch (e) { remaining = 0; }
    allowance = Math.min(allowance, Math.max(0, remaining - cfg.transactionalReserve));
  }
  return allowance;
}

function overFrequencyCap(customerId, ctx, cfg) {
  var since = ctx.now - cfg.frequencyDays * DAY_MS;
  return (ctx.sentAtByCustomer[customerId] || []).filter(function (t) { return t >= since; }).length >= cfg.maxPerWindow;
}

/**
 * Claims the (campaign, customer) slot: re-reads CampaignEvents INSIDE the
 * script lock and appends a QUEUED row only if none exists. Two sweeps that
 * somehow overlap therefore cannot both email the same person.
 */
function claimMarketingEvent(c, cust, cfg) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('CampaignEvents');
    var taken = sheetToObjects(sheet).some(function (e) {
      return e.CampaignId === c.CampaignId && e.CustomerId === cust.CustomerId && e.EventType === 'DELIVERY'
        && !(e.Status === 'DRY_RUN' && !cfg.dryRun);
    });
    if (taken) return null;
    var id = newId('mev');
    appendRowFromObject(sheet, {
      EventId: id, CampaignId: c.CampaignId, CustomerId: cust.CustomerId, Email: cust.Email,
      EventType: 'DELIVERY', Status: cfg.dryRun ? 'DRY_RUN' : 'QUEUED', CreatedAt: nowIso(), SentAt: '',
      FailureReason: '', MetadataJson: '', Attempts: 0
    });
    return id;
  } finally {
    lock.releaseLock();
  }
}

function updateMarketingEvent(eventId, patch) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('CampaignEvents');
    var row = findRowById(sheet, 'EventId', eventId);
    if (row) updateRowFromObject(sheet, row.__row, patch);
  } finally {
    lock.releaseLock();
  }
}

/** One send attempt; returns true when the email went out. */
function deliverMarketingEmail(c, r, ctx, cfg, eventId) {
  var mail = composeCampaignEmail(c, r, ctx, cfg, eventId, r.pref.UnsubscribeToken);
  var sent = false;
  try { sent = sendAppEmail(r.customer.Email, mail.subject, mail.text, mail.html) === true; } catch (e) { sent = false; }
  return sent;
}

function processMarketingQueue(cfg, now) {
  var started = Date.now();
  var ctx = buildMarketingContext(cfg, now);
  var allowance = marketingSendAllowance(cfg, ctx);
  var summary = { campaigns: 0, sent: 0, dryRun: 0, failed: 0, retried: 0, deferred: 0, skipped: 0, stoppedBy: '' };
  var csheet = getSheet('Campaigns');
  var outOfTime = function () { return Date.now() - started > MARKETING_RUN_BUDGET_MS; };

  var due = ctx.campaigns.filter(function (c) {
    return ['READY', 'SCHEDULED', 'PROCESSING'].indexOf(c.Status) !== -1 && msOf(c.StartAt) <= now;
  });
  for (var ci = 0; ci < due.length && ci < MARKETING_MAX_CAMPAIGNS_PER_RUN; ci++) {
    var c = due[ci];
    summary.campaigns++;
    if (msOf(c.EndAt) && msOf(c.EndAt) < now) {
      updateRowFromObject(csheet, c.__row, { Status: (Number(c.SentCount) || 0) > 0 ? 'SENT' : 'CANCELLED', UpdatedAt: nowIso(), LastRunAt: nowIso() });
      continue;
    }
    if (!cfg.siteBase) { summary.stoppedBy = 'SITE_BASE_URL not set'; break; }
    updateRowFromObject(csheet, c.__row, { Status: 'PROCESSING', UpdatedAt: nowIso() });
    var sent = 0, failed = 0;

    // 1. Earlier failures still under the retry limit.
    var retries = ctx.events.filter(function (e) {
      return e.CampaignId === c.CampaignId && e.EventType === 'DELIVERY' && e.Status === 'RETRY';
    });
    for (var ri = 0; ri < retries.length && allowance > 0 && !outOfTime(); ri++) {
      var ev = retries[ri];
      var cust = ctx.customers.filter(function (x) { return x.CustomerId === ev.CustomerId; })[0];
      var plan1 = cust && planCampaignRecipients(c, Object.assign({}, ctx, { events: [] }), cfg).recipients
        .filter(function (x) { return x.customer.CustomerId === ev.CustomerId; })[0];
      var attempts = (Number(ev.Attempts) || 0) + 1;
      if (!plan1) { updateMarketingEvent(ev.EventId, { Status: 'SKIPPED', FailureReason: 'No longer eligible (opted out or nothing to show)' }); summary.skipped++; continue; }
      if (cfg.dryRun) continue;
      var ok1 = deliverMarketingEmail(c, plan1, ctx, cfg, ev.EventId);
      allowance--;
      summary.retried++;
      if (ok1) { updateMarketingEvent(ev.EventId, { Status: 'SENT', SentAt: nowIso(), Attempts: attempts, FailureReason: '' }); sent++; recordPromoSent(plan1, ctx); }
      else { updateMarketingEvent(ev.EventId, { Status: attempts >= cfg.maxRetries ? 'FAILED' : 'RETRY', Attempts: attempts, FailureReason: 'Email service did not accept the message' }); if (attempts >= cfg.maxRetries) failed++; }
    }

    // 2. New recipients.
    var plan = planCampaignRecipients(c, ctx, cfg);
    var remaining = 0;
    for (var pi = 0; pi < plan.recipients.length; pi++) {
      var r = plan.recipients[pi];
      if (allowance <= 0 || outOfTime()) { remaining += plan.recipients.length - pi; break; }
      if (!cfg.dryRun && overFrequencyCap(r.customer.CustomerId, ctx, cfg)) { summary.deferred++; remaining++; continue; }
      var eventId = claimMarketingEvent(c, r.customer, cfg);
      if (!eventId) continue;   // someone else got here first
      if (cfg.dryRun) {
        updateMarketingEvent(eventId, { MetadataJson: JSON.stringify({ reason: r.reason, products: r.products.map(function (p) { return p.ProductId; }) }) });
        summary.dryRun++;
        allowance--;
        continue;
      }
      var ok2 = deliverMarketingEmail(c, r, ctx, cfg, eventId);
      allowance--;
      if (ok2) {
        updateMarketingEvent(eventId, { Status: 'SENT', SentAt: nowIso(), Attempts: 1, MetadataJson: JSON.stringify({ reason: r.reason }) });
        sent++;
        recordPromoSent(r, ctx);
      } else {
        updateMarketingEvent(eventId, { Status: cfg.maxRetries > 1 ? 'RETRY' : 'FAILED', Attempts: 1, FailureReason: 'Email service did not accept the message' });
        if (cfg.maxRetries <= 1) failed++;
      }
    }

    summary.sent += sent;
    summary.failed += failed;
    var stillRetrying = sheetToObjects(getSheet('CampaignEvents')).some(function (e) {
      return e.CampaignId === c.CampaignId && e.EventType === 'DELIVERY' && (e.Status === 'RETRY' || e.Status === 'QUEUED');
    });
    var done = !remaining && !stillRetrying;
    var patch = {
      SentCount: (Number(c.SentCount) || 0) + sent, FailedCount: (Number(c.FailedCount) || 0) + failed,
      LastRunAt: nowIso(), UpdatedAt: nowIso(),
      // Dry run never finishes a campaign: it must still send for real later.
      Status: cfg.dryRun ? 'SCHEDULED' : (done ? 'SENT' : 'SCHEDULED')
    };
    updateRowFromObject(csheet, c.__row, patch);
    if (allowance <= 0) { summary.stoppedBy = 'batch or daily limit'; break; }
    if (outOfTime()) { summary.stoppedBy = 'time budget'; break; }
  }
  return summary;
}

/** Keeps the in-run frequency count and the preference row current. */
function recordPromoSent(r, ctx) {
  (ctx.sentAtByCustomer[r.customer.CustomerId] = ctx.sentAtByCustomer[r.customer.CustomerId] || []).push(Date.now());
  var sheet = getSheet('MarketingPreferences');
  var row = findRowById(sheet, 'CustomerId', r.customer.CustomerId);
  if (row) updateRowFromObject(sheet, row.__row, { LastPromotionalEmailAt: nowIso() });
}

/* ---------------------------------------------------------------------------
 * The scheduled entry point
 * ------------------------------------------------------------------------- */

/**
 * Give this its own hourly time-driven trigger. Does nothing at all unless
 * MARKETING_ENABLED is 'true', and sends nothing while MARKETING_DRY_RUN is on.
 */
function runMarketingSweep() {
  var cfg = marketingConfig();
  if (!cfg.enabled) return { skipped: 'MARKETING_ENABLED is not true' };
  if (cfg.paused) return { skipped: 'paused' };

  // One sweep at a time. The script lock is held only for this check-and-set,
  // never for the sweep itself, so orders and sign-ins are not kept waiting.
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { skipped: 'busy' };
  try {
    var held = Number(props.getProperty(MARKETING_SWEEP_LOCK_KEY)) || 0;
    if (held && Date.now() - held < MARKETING_SWEEP_LOCK_STALE_MS) return { skipped: 'another sweep is running' };
    props.setProperty(MARKETING_SWEEP_LOCK_KEY, String(Date.now()));
  } finally {
    lock.releaseLock();
  }
  try {
    var now = Date.now();
    var created = [];
    try { created = generateMarketingOpportunities(cfg, now); } catch (e) { Logger.log('marketing generation failed: ' + e); }
    var summary = processMarketingQueue(cfg, now);
    summary.created = created.length;
    summary.dryRunMode = cfg.dryRun;
    Logger.log('marketing sweep: ' + JSON.stringify(summary));
    return summary;
  } finally {
    props.deleteProperty(MARKETING_SWEEP_LOCK_KEY);
  }
}

/* ---------------------------------------------------------------------------
 * Stats
 * ------------------------------------------------------------------------- */

/**
 * Per campaign: sent, failed, skipped, dry-run, clicks and conversions. A
 * conversion is an order (not cancelled) by the same email within
 * MARKETING_ATTRIBUTION_DAYS after the email, in the campaign's store when it
 * has one. Opens are not tracked - there is no reliable way to.
 */
function computeMarketingStats(cfg) {
  var events = sheetToObjects(getSheet('CampaignEvents'));
  var campaigns = sheetToObjects(getSheet('Campaigns'));
  var orders = sheetToObjects(getSheet('Orders')).filter(function (o) { return o.Status !== 'Cancelled'; });
  var win = cfg.attributionDays * DAY_MS;
  return campaigns.slice().reverse().slice(0, 100).map(function (c) {
    var ev = events.filter(function (e) { return e.CampaignId === c.CampaignId; });
    var del = ev.filter(function (e) { return e.EventType === 'DELIVERY'; });
    var sent = del.filter(function (e) { return e.Status === 'SENT'; });
    var stores = parseJsonArray(c.StoreSlugsJson);
    var conversions = sent.filter(function (e) {
      var t = msOf(e.SentAt);
      return orders.some(function (o) {
        var ot = msOf(o.CreatedAt);
        return lc(o.CustomerEmail) === lc(e.Email) && ot >= t && ot <= t + win
          && (!stores.length || stores.indexOf(o.StoreSlug) !== -1);
      });
    }).length;
    return {
      campaignId: c.CampaignId, name: c.Name, type: c.Type, status: c.Status,
      sent: sent.length,
      failed: del.filter(function (e) { return e.Status === 'FAILED'; }).length,
      retrying: del.filter(function (e) { return e.Status === 'RETRY'; }).length,
      skipped: del.filter(function (e) { return e.Status === 'SKIPPED'; }).length,
      dryRun: del.filter(function (e) { return e.Status === 'DRY_RUN'; }).length,
      clicks: ev.filter(function (e) { return e.EventType === 'CLICK'; }).length,
      conversions: conversions
    };
  });
}
