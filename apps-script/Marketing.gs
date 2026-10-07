/**
 * Mwakete Marketing Engine - settings, consent, email template, copy, and the
 * admin / customer API actions. The audience, campaign generation, queue and
 * scheduled sweep live in MarketingEngine.gs.
 *
 * WHAT IS PROMOTIONAL AND WHAT IS NOT
 * -----------------------------------
 * Everything this engine sends is PROMOTIONAL and goes only to customers who
 * opted in (MarketingPreferences.PromotionalEmailOptIn = 'true'). Nothing else
 * the app sends is touched: login and sign-up codes, password resets, order
 * and booking emails, chat notifications, seller reminders and the existing
 * abandoned-cart reminder (Reminders.gs runReminderSweep) all keep going
 * through sendAppEmail exactly as before, whatever the switches below say.
 *
 * The abandoned-cart reminder stays the ONE abandoned-cart email: the engine
 * never builds its own. The only cart-derived campaign here (PRODUCT_INTEREST)
 * is for opted-in customers, a week after that reminder, if the item is still
 * listed and was never ordered.
 *
 * SWITCHES (Script Properties; defaults are the safe ones)
 *   MARKETING_ENABLED           false  master kill switch: off = nothing runs
 *   MARKETING_DRY_RUN           true   records who WOULD be emailed, sends none
 *   MARKETING_PAUSED            false  admin pause (toggle on the admin page)
 *   MARKETING_AUTO_APPROVE      false  automatic campaigns wait as DRAFT for an
 *                                      admin to approve, until this is true
 *   MARKETING_DAILY_EMAIL_LIMIT 30     promotional emails per day, all campaigns
 *   MARKETING_BATCH_SIZE        10     emails per hourly run
 *   MARKETING_FREQUENCY_DAYS    7      the window for the per-customer cap
 *   MARKETING_MAX_PER_WINDOW    2      promotional emails per customer per window
 *   MARKETING_MAX_RETRIES       2      sends attempted before an event is FAILED
 *   MARKETING_INACTIVE_DAYS     30     no order/booking/review/cart for this long
 *   MARKETING_ATTRIBUTION_DAYS  7      order within this long after = conversion
 *   MARKETING_TRANSACTIONAL_RESERVE 40 MailApp quota always left for login
 *                                      codes, orders and the rest
 * Needs SITE_BASE_URL (already used by notification emails) for links.
 */

var MARKETING_DEFAULTS = {
  MARKETING_ENABLED: 'false',
  MARKETING_DRY_RUN: 'true',
  MARKETING_PAUSED: 'false',
  MARKETING_AUTO_APPROVE: 'false',
  MARKETING_DAILY_EMAIL_LIMIT: '30',
  MARKETING_BATCH_SIZE: '10',
  MARKETING_FREQUENCY_DAYS: '7',
  MARKETING_MAX_PER_WINDOW: '2',
  MARKETING_MAX_RETRIES: '2',
  MARKETING_INACTIVE_DAYS: '30',
  MARKETING_ATTRIBUTION_DAYS: '7',
  MARKETING_TRANSACTIONAL_RESERVE: '40'
};

var CAMPAIGN_STATUSES = ['DRAFT', 'READY', 'SCHEDULED', 'PROCESSING', 'SENT', 'PAUSED', 'CANCELLED', 'FAILED'];
// Types the engine creates on its own, and types only an admin can create.
var AUTO_CAMPAIGN_TYPES = ['PRODUCT_INTEREST', 'STORE_UPDATE', 'CATEGORY_TRENDING', 'NEW_PRODUCTS', 'INACTIVE_CUSTOMER', 'RETURNING_CUSTOMER'];
var MANUAL_CAMPAIGN_TYPES = ['SELLER_PROMOTION', 'SEASONAL'];
var MANUAL_AUDIENCES = ['ALL_OPTED_IN', 'STORE_CUSTOMERS', 'CATEGORY_INTEREST'];

function marketingConfig() {
  var props = PropertiesService.getScriptProperties();
  var get = function (k) {
    var v = props.getProperty(k);
    return v == null || v === '' ? MARKETING_DEFAULTS[k] : String(v).trim();
  };
  var num = function (k, min, max) {
    var n = parseInt(get(k), 10);
    if (isNaN(n)) n = parseInt(MARKETING_DEFAULTS[k], 10);
    return Math.max(min, Math.min(max, n));
  };
  return {
    enabled: get('MARKETING_ENABLED') === 'true',
    // Anything but an explicit 'false' keeps dry run on: a typo never sends.
    dryRun: get('MARKETING_DRY_RUN') !== 'false',
    paused: get('MARKETING_PAUSED') === 'true',
    autoApprove: get('MARKETING_AUTO_APPROVE') === 'true',
    dailyLimit: num('MARKETING_DAILY_EMAIL_LIMIT', 0, 500),
    batchSize: num('MARKETING_BATCH_SIZE', 1, 50),
    frequencyDays: num('MARKETING_FREQUENCY_DAYS', 1, 60),
    maxPerWindow: num('MARKETING_MAX_PER_WINDOW', 1, 10),
    maxRetries: num('MARKETING_MAX_RETRIES', 1, 5),
    inactiveDays: num('MARKETING_INACTIVE_DAYS', 7, 365),
    attributionDays: num('MARKETING_ATTRIBUTION_DAYS', 1, 60),
    transactionalReserve: num('MARKETING_TRANSACTIONAL_RESERVE', 0, 1000),
    siteBase: siteBaseUrl()
  };
}

/* ---------------------------------------------------------------------------
 * Consent (MarketingPreferences)
 * ------------------------------------------------------------------------- */

function findMarketingPreference(customerId) {
  return sheetToObjects(getSheet('MarketingPreferences')).filter(function (r) {
    return String(r.CustomerId) === String(customerId);
  })[0] || null;
}

/** Opted in only on an explicit 'true'. A missing row means "never asked" = no. */
function isOptedIn(pref) {
  return !!pref && String(pref.PromotionalEmailOptIn) === 'true';
}

function setMarketingOptIn(customer, optIn) {
  var sheet = getSheet('MarketingPreferences');
  var pref = findMarketingPreference(customer.CustomerId);
  var now = nowIso();
  if (pref) {
    var patch = { PromotionalEmailOptIn: optIn ? 'true' : 'false', Email: customer.Email, UpdatedAt: now };
    if (optIn && !isOptedIn(pref)) patch.OptInAt = now;
    if (!pref.UnsubscribeToken) patch.UnsubscribeToken = newId('unsub') + newId('k').slice(2);
    updateRowFromObject(sheet, pref.__row, patch);
  } else {
    appendRowFromObject(sheet, {
      CustomerId: customer.CustomerId,
      Email: customer.Email,
      PromotionalEmailOptIn: optIn ? 'true' : 'false',
      FrequencyLimit: '',
      LastPromotionalEmailAt: '',
      UpdatedAt: now,
      OptInAt: optIn ? now : '',
      UnsubscribeToken: newId('unsub') + newId('k').slice(2)
    });
  }
}

/** body.token (customer session). The customer's own setting only. */
function actionGetMarketingPreference(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }
  return ok({ optIn: isOptedIn(findMarketingPreference(customer.CustomerId)) });
}

/** body.token, body.optIn. Never takes a customer id or email from the request. */
function actionSetMarketingPreference(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    setMarketingOptIn(customer, body.optIn === true || body.optIn === 'true');
  } finally {
    lock.releaseLock();
  }
  return ok({ optIn: body.optIn === true || body.optIn === 'true' });
}

/**
 * body.t - the unsubscribe token from an email link. Works without signing
 * in (that is the point of a one-tap unsubscribe). The token is random and
 * per customer, so it can only ever switch OFF that one customer's emails;
 * an unknown token answers the same as a known one, so tokens cannot be
 * probed.
 */
function actionUnsubscribeMarketing(body) {
  var token = String(body.t || '').trim();
  if (!/^unsub_[a-z0-9]{20,}$/i.test(token)) return ok({ unsubscribed: true });
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('MarketingPreferences');
    var pref = sheetToObjects(sheet).filter(function (r) { return String(r.UnsubscribeToken) === token; })[0];
    if (pref && isOptedIn(pref)) {
      updateRowFromObject(sheet, pref.__row, { PromotionalEmailOptIn: 'false', UpdatedAt: nowIso() });
    }
  } finally {
    lock.releaseLock();
  }
  return ok({ unsubscribed: true });
}

/* ---------------------------------------------------------------------------
 * Copy: deterministic, from real data only
 * ------------------------------------------------------------------------- */

/**
 * The headline, intro and button text for a campaign. Built only from facts
 * on file - names, stores, places - never prices, stock, discounts, delivery
 * times or superlatives ("best", "cheapest", "limited"), which the engine has
 * no way to verify.
 *
 * The one seam for AI-written copy later: a provider could be tried here
 * first, with this deterministic text as the fallback. None is wired today,
 * and the engine never needs one.
 */
function generateCampaignCopy(type, ctx) {
  ctx = ctx || {};
  var store = ctx.storeName || '';
  var cat = ctx.categoryName || '';
  switch (type) {
    case 'PRODUCT_INTEREST':
      return { subject: 'Still thinking about ' + (ctx.productName || 'it') + '?',
        headline: 'Still interested?',
        intro: (ctx.productName || 'An item you added to your cart') + (store ? ' from ' + store : '') + ' is still on Mwakete.',
        cta: 'View product' };
    case 'STORE_UPDATE':
      return { subject: 'New at ' + store + ' on Mwakete',
        headline: 'New at ' + store,
        intro: store + ' has added new listings since you last shopped there.',
        cta: 'Visit the store' };
    case 'CATEGORY_TRENDING':
      return { subject: 'Popular on Mwakete' + (cat ? ' in ' + cat : ''),
        headline: 'Popular on Mwakete',
        intro: 'Listings shoppers have been looking at' + (cat ? ' in ' + cat : '') + '.',
        cta: 'See more on Mwakete' };
    case 'NEW_PRODUCTS':
      return { subject: 'New on Mwakete this week',
        headline: 'New on Mwakete',
        intro: 'A few of the newest listings from local sellers.',
        cta: 'See what is new' };
    case 'INACTIVE_CUSTOMER':
      return { subject: 'What is new on Mwakete',
        headline: 'What is new on Mwakete',
        intro: 'Here are some listings added since your last visit.',
        cta: 'Browse Mwakete' };
    case 'RETURNING_CUSTOMER':
      return { subject: 'More from the stores you know on Mwakete',
        headline: 'Picked from the stores you know',
        intro: 'Listings from stores and categories you have ordered from before.',
        cta: 'Take a look' };
    default:
      return { subject: ctx.subject || 'News from Mwakete', headline: ctx.subject || 'News from Mwakete',
        intro: ctx.message || '', cta: ctx.cta || 'Visit Mwakete' };
  }
}

/* ---------------------------------------------------------------------------
 * Email template
 * ------------------------------------------------------------------------- */

var MARKETING_VARIABLES = ['customerName', 'storeName', 'productName', 'productUrl', 'storeUrl', 'categoryName'];

/**
 * Replaces {{variable}} with a value - on PLAIN TEXT. The result is escaped
 * by the template like everything else, so a variable can never smuggle
 * markup into the email. Unknown {{names}} are dropped.
 */
function fillMarketingVariables(text, vars) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, name) {
    return MARKETING_VARIABLES.indexOf(name) !== -1 && vars[name] != null ? String(vars[name]) : '';
  });
}

/** Only our own site's pages may be linked, and only over https. */
function safeMarketingUrl(url, base) {
  var u = String(url || '');
  if (!base || u.indexOf(base + '/') !== 0) return '';
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}

/**
 * Renders one email. Every value is plain text escaped here; there is no
 * path for HTML from a Sheet cell or an admin form into the email.
 * m: { headline, intro, items: [{ name, meta, url, imageUrl }], ctaLabel,
 *      ctaUrl, unsubscribeUrl, base }
 */
function renderMarketingEmail(m) {
  var e = escapeHtmlForEmail;
  var base = m.base;
  var items = (m.items || []).slice(0, 4);
  var lines = [];
  lines.push('Mwakete', '', m.headline, '', m.intro, '');
  items.forEach(function (it) {
    lines.push('- ' + it.name + (it.meta ? ' (' + it.meta + ')' : '') + (safeMarketingUrl(it.url, base) ? '\n  ' + it.url : ''));
  });
  var cta = safeMarketingUrl(m.ctaUrl, base);
  if (cta) lines.push('', m.ctaLabel + ': ' + cta);
  lines.push('', '--', 'You are receiving this because you asked for news from Mwakete.',
    'Stop these emails: ' + (safeMarketingUrl(m.unsubscribeUrl, base) || 'reply and ask'));
  var text = lines.join('\n');

  var cards = items.map(function (it) {
    var url = safeMarketingUrl(it.url, base);
    var img = /^https:\/\/[^\s"'<>]+$/.test(String(it.imageUrl || '')) ? it.imageUrl : '';
    return '<tr><td style="padding:8px 0;border-top:1px solid #e3e1ee">'
      + '<table role="presentation" cellpadding="0" cellspacing="0"><tr>'
      + (img ? '<td style="padding-right:12px" valign="top"><img src="' + e(img) + '" width="64" height="64" alt="" style="display:block;border-radius:8px;object-fit:cover"></td>' : '')
      + '<td valign="top"><a href="' + e(url || base) + '" style="color:#332d63;font-weight:bold;text-decoration:none">' + e(it.name) + '</a>'
      + (it.meta ? '<div style="color:#5f6368;font-size:13px">' + e(it.meta) + '</div>' : '')
      + '</td></tr></table></td></tr>';
  }).join('');
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">'
    + '<div style="background:#ce1126;border-bottom:4px solid #fcd116;padding:12px 16px;color:#fff;font-weight:bold;font-size:18px">Mwakete</div>'
    + '<div style="padding:16px">'
    + '<h1 style="font-size:20px;color:#332d63;margin:0 0 8px">' + e(m.headline) + '</h1>'
    + '<p style="margin:0 0 12px;line-height:1.5">' + e(m.intro).replace(/\n/g, '<br>') + '</p>'
    + (cards ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + cards + '</table>' : '')
    + (cta ? '<p style="margin:16px 0"><a href="' + e(cta) + '" style="background:#332d63;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">' + e(m.ctaLabel) + '</a></p>' : '')
    + '</div>'
    + '<div style="padding:12px 16px;border-top:1px solid #e3e1ee;color:#5f6368;font-size:12px">'
    + 'You are receiving this because you asked for news from Mwakete. '
    + (safeMarketingUrl(m.unsubscribeUrl, base) ? '<a href="' + e(m.unsubscribeUrl) + '" style="color:#5f6368">Stop these emails</a>' : '')
    + '</div></div>';
  return { text: text, html: html };
}

/* ---------------------------------------------------------------------------
 * Admin actions (all require isOwnerAdmin; none returns an email address)
 * ------------------------------------------------------------------------- */

function requireMarketingAdmin(owner) {
  if (!isOwnerAdmin(owner)) throw new Error('Not authorized');
}

function campaignSummary(c) {
  return {
    campaignId: c.CampaignId, name: c.Name, type: c.Type, status: c.Status,
    audienceType: c.AudienceType, subject: c.Subject, startAt: c.StartAt, endAt: c.EndAt,
    createdAt: c.CreatedAt, createdBy: c.CreatedBy === 'engine' ? 'Automatic' : 'Admin', sentCount: Number(c.SentCount) || 0,
    failedCount: Number(c.FailedCount) || 0, lastRunAt: c.LastRunAt,
    storeSlugs: parseJsonArray(c.StoreSlugsJson), productIds: parseJsonArray(c.ProductIdsJson)
  };
}

function parseJsonArray(s) {
  try { var v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

/** Overview: switches, counts and the campaign list. No recipient data. */
function actionGetMarketingOverview(owner) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  var cfg = marketingConfig();
  var campaigns = sheetToObjects(getSheet('Campaigns'));
  var events = sheetToObjects(getSheet('CampaignEvents'));
  var prefs = sheetToObjects(getSheet('MarketingPreferences'));
  var count = function (st) { return campaigns.filter(function (c) { return c.Status === st; }).length; };
  return ok({
    settings: {
      enabled: cfg.enabled, dryRun: cfg.dryRun, paused: cfg.paused, autoApprove: cfg.autoApprove,
      dailyLimit: cfg.dailyLimit, batchSize: cfg.batchSize, frequencyDays: cfg.frequencyDays,
      maxPerWindow: cfg.maxPerWindow, siteBaseSet: !!cfg.siteBase
    },
    totals: {
      campaigns: campaigns.length,
      drafts: count('DRAFT'),
      scheduled: count('SCHEDULED') + count('READY') + count('PROCESSING'),
      sent: count('SENT'),
      failedCampaigns: count('FAILED'),
      emailsSent: events.filter(function (v) { return v.EventType === 'DELIVERY' && v.Status === 'SENT'; }).length,
      emailsFailed: events.filter(function (v) { return v.EventType === 'DELIVERY' && v.Status === 'FAILED'; }).length,
      dryRun: events.filter(function (v) { return v.EventType === 'DELIVERY' && v.Status === 'DRY_RUN'; }).length,
      optedIn: prefs.filter(isOptedIn).length
    },
    campaigns: campaigns.slice().reverse().slice(0, 100).map(campaignSummary)
  });
}

/**
 * Admin-created campaigns: SELLER_PROMOTION (one store, optionally chosen
 * products) and SEASONAL. Created as DRAFT - nothing sends until an admin
 * approves it with setMarketingCampaignStatus. The message is plain text;
 * prices, discounts and stock are never filled in by the engine, so any such
 * claim is the admin's own words.
 */
function actionCreateMarketingCampaign(owner, body) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  var type = String(body.type || '');
  if (MANUAL_CAMPAIGN_TYPES.indexOf(type) === -1) return fail('Choose Seller promotion or Seasonal');
  var name = String(body.name || '').trim();
  var subject = String(body.subject || '').replace(/[\r\n\t]+/g, ' ').trim();
  var message = String(body.message || '').trim();
  if (!name || name.length > 120) return fail('Give the campaign a name (up to 120 characters)');
  if (!subject || subject.length > 120) return fail('Add a subject line (up to 120 characters)');
  if (!message || message.length > 2000) return fail('Add a message (up to 2000 characters)');
  if (/[<>]/.test(subject + message + name)) return fail('Plain text only - no HTML');
  var audience = String(body.audience || 'ALL_OPTED_IN');
  if (MANUAL_AUDIENCES.indexOf(audience) === -1) return fail('Unknown audience');

  var owners = sheetToObjects(getSheet('Owners'));
  var products = sheetToObjects(getSheet('Products'));
  var storeSlug = String(body.storeSlug || '').trim();
  var store = null;
  if (storeSlug) {
    store = owners.filter(function (o) { return o.StoreSlug === storeSlug && isStoreBrowsable(o); })[0];
    if (!store) return fail('That store is not open on Mwakete');
  }
  if (type === 'SELLER_PROMOTION' && !store) return fail('Choose the store this promotion is for');
  if (audience === 'STORE_CUSTOMERS' && !store) return fail('Choose a store for this audience');

  // Products must be live and, when a store is chosen, that store's own.
  var productIds = (Array.isArray(body.productIds) ? body.productIds : []).map(String).slice(0, 4);
  for (var i = 0; i < productIds.length; i++) {
    var p = products.filter(function (x) { return x.ProductId === productIds[i] && x.Status === 'active'; })[0];
    if (!p) return fail('A chosen product is not listed');
    if (store && p.OwnerId !== store.OwnerId) return fail('A chosen product is not from that store');
  }
  var category = String(body.category || '').trim();
  if (audience === 'CATEGORY_INTEREST' && !category) return fail('Choose a category for this audience');

  var startAt = body.startAt ? new Date(body.startAt) : new Date();
  var endAt = body.endAt ? new Date(body.endAt) : new Date(startAt.getTime() + 14 * 86400000);
  if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) return fail('Check the start and end dates');
  if (endAt.getTime() < Date.now()) return fail('The end date has already passed');
  var max = Math.max(0, Math.min(5000, parseInt(body.maxRecipients, 10) || 0));

  var id = newId('cmp');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    appendRowFromObject(getSheet('Campaigns'), {
      CampaignId: id, Name: name, Type: type, Status: 'DRAFT',
      Objective: type === 'SEASONAL' ? 'Seasonal' : 'Store promotion',
      AudienceType: audience,
      AudienceFilterJson: JSON.stringify({ category: category }),
      ProductIdsJson: JSON.stringify(productIds),
      StoreSlugsJson: JSON.stringify(store ? [store.StoreSlug] : []),
      Subject: subject, PreviewText: message.slice(0, 120), BodyHtml: '', BodyText: message,
      CTAUrl: '', CTAType: store ? 'store' : 'home', StartAt: startAt.toISOString(), EndAt: endAt.toISOString(),
      CreatedAt: nowIso(), UpdatedAt: nowIso(), CreatedBy: owner.Email, MaxRecipients: max || '',
      SentCount: 0, FailedCount: 0, LastRunAt: '', SourceKey: ''
    });
  } finally {
    lock.releaseLock();
  }
  return ok({ campaignId: id });
}

var CAMPAIGN_TRANSITIONS = {
  approve: { from: ['DRAFT'], to: 'SCHEDULED' },
  pause: { from: ['READY', 'SCHEDULED', 'PROCESSING'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'SCHEDULED' },
  cancel: { from: ['DRAFT', 'READY', 'SCHEDULED', 'PROCESSING', 'PAUSED'], to: 'CANCELLED' }
};

/** body.campaignId, body.op: approve | pause | resume | cancel. */
function actionSetMarketingCampaignStatus(owner, body) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  var t = CAMPAIGN_TRANSITIONS[String(body.op || '')];
  if (!t) return fail('Unknown action');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('Campaigns');
    var c = findRowById(sheet, 'CampaignId', String(body.campaignId || ''));
    if (!c) return fail('Campaign not found');
    if (t.from.indexOf(c.Status) === -1) return fail('A ' + c.Status.toLowerCase() + ' campaign cannot be changed that way');
    updateRowFromObject(sheet, c.__row, { Status: t.to, UpdatedAt: nowIso() });
    return ok({ status: t.to });
  } finally {
    lock.releaseLock();
  }
}

/** The admin page's Pause all / Resume all - the soft switch. MARKETING_ENABLED stays a deploy-time setting. */
function actionSetMarketingPaused(owner, body) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  PropertiesService.getScriptProperties().setProperty('MARKETING_PAUSED', body.paused ? 'true' : 'false');
  return ok({ paused: !!body.paused });
}

/**
 * What a campaign would do right now: audience size, the reasons people
 * qualify (counted, never named), and the email rendered for a sample
 * recipient called "there". No address leaves the server.
 */
function actionPreviewMarketingCampaign(owner, body) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  var c = findRowById(getSheet('Campaigns'), 'CampaignId', String(body.campaignId || ''));
  if (!c) return fail('Campaign not found');
  var cfg = marketingConfig();
  var ctx = buildMarketingContext(cfg, Date.now());
  var plan = planCampaignRecipients(c, ctx, cfg);
  var sample = plan.recipients[0];
  var rendered = sample
    ? composeCampaignEmail(c, sample, ctx, cfg, 'preview', 'unsub_preview')
    : null;
  var reasons = {};
  plan.recipients.forEach(function (r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
  return ok({
    campaign: campaignSummary(c),
    audienceSize: plan.recipients.length,
    alreadyHandled: plan.alreadyHandled,
    reasons: reasons,
    estimatedEmails: Math.min(plan.recipients.length, Number(c.MaxRecipients) || plan.recipients.length),
    sample: rendered ? { subject: rendered.subject, text: rendered.text.replace(/\n  https?:\S+/g, '') } : null
  });
}

/** Stats per campaign: sent, failed, skipped, clicks and conversions (orders within the attribution window). */
function actionGetMarketingStats(owner) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  return ok({ stats: computeMarketingStats(marketingConfig()) });
}

/** Runs generation once, now, without sending - for "what would it create?" */
function actionRunMarketingGeneration(owner) {
  try { requireMarketingAdmin(owner); } catch (e) { return fail(e.message); }
  var cfg = marketingConfig();
  var created = generateMarketingOpportunities(cfg, Date.now());
  return ok({ created: created });
}

/**
 * Public: the link in an email carries ?mc=<campaignId>&me=<eventId>. The
 * product or store page reports it once; it only counts if that event really
 * belongs to that campaign, and only once per event. Nothing else is stored.
 */
function actionRecordMarketingClick(body) {
  var cid = String(body.mc || ''), eid = String(body.me || '');
  if (!/^cmp_[a-z0-9]{16}$/.test(cid) || !/^mev_[a-z0-9]{16}$/.test(eid)) return ok({});
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('CampaignEvents');
    var rows = sheetToObjects(sheet);
    var delivery = rows.filter(function (r) { return r.EventId === eid && r.CampaignId === cid && r.EventType === 'DELIVERY' && r.Status === 'SENT'; })[0];
    if (!delivery) return ok({});
    var clickId = 'click:' + eid;
    if (rows.some(function (r) { return r.EventType === 'CLICK' && r.MetadataJson === clickId; })) return ok({});
    appendRowFromObject(sheet, {
      EventId: newId('mev'), CampaignId: cid, CustomerId: delivery.CustomerId, Email: '',
      EventType: 'CLICK', Status: 'RECORDED', CreatedAt: nowIso(), SentAt: '', FailureReason: '',
      MetadataJson: clickId, Attempts: ''
    });
  } finally {
    lock.releaseLock();
  }
  return ok({});
}
