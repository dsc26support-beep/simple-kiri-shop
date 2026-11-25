/**
 * Customer Engagement (CESN Stage 2) - Follow, Like, per-store marketing
 * consent, the in-app Notification Centre, and the seller's audience view.
 *
 * Three INDEPENDENT relationships, enforced here and never conflated:
 *   - Follow  (StoreFollows)  -> Favourites + notification eligibility; needs no purchase.
 *   - Like    (StoreLikes)    -> a count + that one store's eligibility; NOT Favourites.
 *   - Consent (StoreMarketingConsents) -> explicit, per-store opt-in; a purchase
 *                                NEVER creates it, and it is never pre-set.
 * A purchaser is derived from Orders (OwnerId) and is its own thing again.
 *
 * This file only reads/writes its own new tabs plus read-only lookups
 * (getOwnerBySlug, Customers, Orders). It does not touch the global
 * MarketingPreferences email opt-in (Marketing.gs) - that stays as it was.
 *
 * Every mutation takes the script lock and trusts the signed-in customer from
 * the session token only (never a customer id/email from the body), the same
 * contract as actionSetMarketingPreference.
 */

var ENGAGEMENT_NOTIFICATION_LIMIT = 50;

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

// Validate a store slug against the Owners tab; throw a public-safe error if
// it is missing. Returns the canonical slug.
function engagementRequireSlug_(body) {
  var slug = String((body && body.storeSlug) || '').trim().toLowerCase();
  if (!slug) throw new Error('storeSlug is required');
  if (!getOwnerBySlug(slug)) throw new Error('Store not found');
  return slug;
}

// Active rows for a (tab, slug) - the live relationships for a store.
function engagementActiveForStore_(sheetName, slug) {
  return sheetToObjects(getSheet(sheetName)).filter(function (r) {
    return String(r.StoreSlug) === String(slug) && String(r.Status) === 'active';
  });
}

// The one active row for (customer, slug), or null. Also returns removed rows
// so a re-follow can reactivate instead of piling up rows.
function engagementRowFor_(sheetName, customerId, slug) {
  var rows = sheetToObjects(getSheet(sheetName)).filter(function (r) {
    return String(r.CustomerId) === String(customerId) && String(r.StoreSlug) === String(slug);
  });
  var active = rows.filter(function (r) { return String(r.Status) === 'active'; })[0];
  return { active: active || null, any: rows[0] || null };
}

function engagementCounts_(slug) {
  return {
    followers: engagementActiveForStore_('StoreFollows', slug).length,
    likes: engagementActiveForStore_('StoreLikes', slug).length
  };
}

// Append an in-app notification for a customer. The later smart engine reuses
// this; Stage 2 calls it to seed a welcome note on a first follow. In-app only
// - it never sends an OS push (that is a later stage, gated on an explicit
// permission the customer grants).
function appendNotification_(customerId, note) {
  note = note || {};
  appendRowFromObject(getSheet('Notifications'), {
    NotificationId: newId('ntf'),
    CustomerId: customerId,
    StoreSlug: note.storeSlug || '',
    Category: note.category || 'store_update',
    Title: note.title || '',
    Body: note.body || '',
    ImageUrl: note.imageUrl || '',
    DeepLink: note.deepLink || '',
    CampaignId: note.campaignId || '',
    ReadAt: '',
    CreatedAt: nowIso()
  });
}

/* ---------------------------------------------------------------------------
 * Follow / Unfollow
 * ------------------------------------------------------------------------- */

function actionFollowStore(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = engagementRowFor_('StoreFollows', customer.CustomerId, slug);
    var firstEver = !found.any;
    if (!found.active) {
      var sheet = getSheet('StoreFollows');
      if (found.any) {
        updateRowFromObject(sheet, found.any.__row, { Status: 'active', NotifyOn: 'true', UpdatedAt: nowIso() });
      } else {
        appendRowFromObject(sheet, {
          FollowId: newId('flw'), CustomerId: customer.CustomerId, StoreSlug: slug,
          Status: 'active', NotifyOn: 'true', CreatedAt: nowIso(), UpdatedAt: nowIso()
        });
      }
      // Welcome note on the very first follow of this store (in-app only).
      if (firstEver) {
        var ownerRow = getOwnerBySlug(slug);
        appendNotification_(customer.CustomerId, {
          storeSlug: slug, category: 'store_follow',
          title: 'You’re following ' + ((ownerRow && ownerRow.StoreName) || 'this store'),
          body: 'You’ll see new arrivals and offers from this store here.',
          deepLink: 'store.html?store=' + encodeURIComponent(slug)
        });
      }
    }
  } finally { lock.releaseLock(); }
  var c = engagementCounts_(slug);
  return ok({ following: true, liked: !!engagementRowFor_('StoreLikes', customer.CustomerId, slug).active,
    followers: c.followers, likes: c.likes });
}

function actionUnfollowStore(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = engagementRowFor_('StoreFollows', customer.CustomerId, slug);
    if (found.active) updateRowFromObject(getSheet('StoreFollows'), found.active.__row, { Status: 'removed', UpdatedAt: nowIso() });
  } finally { lock.releaseLock(); }
  var c = engagementCounts_(slug);
  return ok({ following: false, followers: c.followers, likes: c.likes });
}

/* ---------------------------------------------------------------------------
 * Like / Unlike (independent of Follow - no Favourites, count only)
 * ------------------------------------------------------------------------- */

function actionLikeStore(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = engagementRowFor_('StoreLikes', customer.CustomerId, slug);
    if (!found.active) {
      var sheet = getSheet('StoreLikes');
      if (found.any) updateRowFromObject(sheet, found.any.__row, { Status: 'active', NotifyOn: 'true', UpdatedAt: nowIso() });
      else appendRowFromObject(sheet, {
        LikeId: newId('lik'), CustomerId: customer.CustomerId, StoreSlug: slug,
        Status: 'active', NotifyOn: 'true', CreatedAt: nowIso(), UpdatedAt: nowIso()
      });
    }
  } finally { lock.releaseLock(); }
  var c = engagementCounts_(slug);
  return ok({ liked: true, following: !!engagementRowFor_('StoreFollows', customer.CustomerId, slug).active,
    followers: c.followers, likes: c.likes });
}

function actionUnlikeStore(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = engagementRowFor_('StoreLikes', customer.CustomerId, slug);
    if (found.active) updateRowFromObject(getSheet('StoreLikes'), found.active.__row, { Status: 'removed', UpdatedAt: nowIso() });
  } finally { lock.releaseLock(); }
  var c = engagementCounts_(slug);
  return ok({ liked: false, followers: c.followers, likes: c.likes });
}

/* ---------------------------------------------------------------------------
 * Public engagement state (counts always; per-customer state if signed in)
 * ------------------------------------------------------------------------- */

function actionGetStoreEngagement(body) {
  var slug = engagementRequireSlug_(body);
  var c = engagementCounts_(slug);
  var out = { followers: c.followers, likes: c.likes };
  // Token is optional here: counts are public, personal state needs a session.
  if (body && body.token) {
    var customer = null;
    try { customer = requireCustomerAuth(body.token); } catch (e) { customer = null; }
    if (customer) {
      out.signedIn = true;
      out.following = !!engagementRowFor_('StoreFollows', customer.CustomerId, slug).active;
      out.liked = !!engagementRowFor_('StoreLikes', customer.CustomerId, slug).active;
      out.consent = !!engagementRowFor_('StoreMarketingConsents', customer.CustomerId, slug).active;
    }
  }
  return ok(out);
}

/* ---------------------------------------------------------------------------
 * Per-store marketing consent (explicit opt-in; withdrawal keeps history)
 * ------------------------------------------------------------------------- */

function actionSetStoreMarketingConsent(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  // Must be an explicit, affirmative opt-in. Anything other than a true value
  // is treated as a withdrawal, never as a silent opt-in.
  var optIn = body.optIn === true || body.optIn === 'true';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('StoreMarketingConsents');
    var found = engagementRowFor_('StoreMarketingConsents', customer.CustomerId, slug);
    var now = nowIso();
    if (optIn) {
      if (found.active) { /* already on */ }
      else if (found.any) updateRowFromObject(sheet, found.any.__row, { Status: 'active', OptInAt: now, WithdrawnAt: '', UpdatedAt: now });
      else appendRowFromObject(sheet, {
        ConsentId: newId('cns'), CustomerId: customer.CustomerId, StoreSlug: slug,
        Status: 'active', OptInAt: now, WithdrawnAt: '', CreatedAt: now, UpdatedAt: now
      });
    } else if (found.active) {
      updateRowFromObject(sheet, found.active.__row, { Status: 'withdrawn', WithdrawnAt: now, UpdatedAt: now });
    }
  } finally { lock.releaseLock(); }
  return ok({ consent: optIn });
}

/* ---------------------------------------------------------------------------
 * Favourite Stores (the customer's followed stores + per-store state)
 * ------------------------------------------------------------------------- */

function actionGetFavouriteStores(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var cid = customer.CustomerId;
  var follows = sheetToObjects(getSheet('StoreFollows')).filter(function (r) {
    return String(r.CustomerId) === String(cid) && String(r.Status) === 'active';
  });
  var consentBySlug = {};
  sheetToObjects(getSheet('StoreMarketingConsents')).forEach(function (r) {
    if (String(r.CustomerId) === String(cid) && String(r.Status) === 'active') consentBySlug[String(r.StoreSlug)] = true;
  });
  var stores = follows.map(function (f) {
    var o = getOwnerBySlug(String(f.StoreSlug)) || {};
    return {
      storeSlug: f.StoreSlug,
      storeName: o.StoreName || f.StoreSlug,
      logoUrl: o.LogoUrl || '',
      island: o.Island || '', village: o.Village || '',
      notifyOn: String(f.NotifyOn) !== 'false',
      consent: !!consentBySlug[String(f.StoreSlug)],
      since: f.CreatedAt || ''
    };
  }).sort(function (a, b) { return String(b.since).localeCompare(String(a.since)); });
  return ok({ stores: stores });
}

// Turn per-store notifications on/off from Favourite Stores (independent of the
// follow itself and of consent). Applies to the follow row for this store.
function actionSetStoreNotifyPreference(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var slug = engagementRequireSlug_(body);
  var on = !(body.notifyOn === false || body.notifyOn === 'false');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = engagementRowFor_('StoreFollows', customer.CustomerId, slug);
    if (found.active) updateRowFromObject(getSheet('StoreFollows'), found.active.__row, { NotifyOn: on ? 'true' : 'false', UpdatedAt: nowIso() });
  } finally { lock.releaseLock(); }
  return ok({ notifyOn: on });
}

/* ---------------------------------------------------------------------------
 * In-app Notification Centre
 * ------------------------------------------------------------------------- */

function actionGetNotifications(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var cid = customer.CustomerId;
  var rows = sheetToObjects(getSheet('Notifications')).filter(function (r) {
    return String(r.CustomerId) === String(cid);
  }).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  var unread = rows.filter(function (r) { return !String(r.ReadAt); }).length;
  var items = rows.slice(0, ENGAGEMENT_NOTIFICATION_LIMIT).map(function (r) {
    return {
      id: r.NotificationId, storeSlug: r.StoreSlug, category: r.Category,
      title: r.Title, body: r.Body, imageUrl: r.ImageUrl, deepLink: r.DeepLink,
      read: !!String(r.ReadAt), createdAt: r.CreatedAt
    };
  });
  return ok({ notifications: items, unread: unread });
}

function actionMarkNotificationRead(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(publicErrorMessage(e, 'auth')); }
  var cid = customer.CustomerId;
  var all = body.all === true || body.all === 'true';
  var wantId = String(body.notificationId || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('Notifications');
    sheetToObjects(sheet).forEach(function (r) {
      if (String(r.CustomerId) !== String(cid)) return;      // only the customer's own
      if (String(r.ReadAt)) return;
      if (all || String(r.NotificationId) === wantId) updateRowFromObject(sheet, r.__row, { ReadAt: nowIso() });
    });
  } finally { lock.releaseLock(); }
  return actionGetNotifications(body);
}

/* ---------------------------------------------------------------------------
 * Seller audience view (owner-authed; this owner's store only)
 * ------------------------------------------------------------------------- */

function actionGetStoreEngagementAudiences(owner, body) {
  var slug = owner.StoreSlug;
  var activeSlug = function (r) { return String(r.StoreSlug) === String(slug) && String(r.Status) === 'active'; };
  var followers = sheetToObjects(getSheet('StoreFollows')).filter(activeSlug);
  var likers = sheetToObjects(getSheet('StoreLikes')).filter(activeSlug);
  var subscribers = sheetToObjects(getSheet('StoreMarketingConsents')).filter(activeSlug);
  var purchasers = sheetToObjects(getSheet('Orders')).filter(function (o) { return String(o.OwnerId) === String(owner.OwnerId); });

  // Merge every customer that has ANY relationship, de-duplicated by CustomerId.
  var byId = {};
  var touch = function (cid) { if (!byId[cid]) byId[cid] = { customerId: cid, follower: false, liker: false, purchaser: false, subscriber: false, since: '' }; return byId[cid]; };
  followers.forEach(function (r) { var e = touch(String(r.CustomerId)); e.follower = true; e.since = r.CreatedAt || e.since; });
  likers.forEach(function (r) { touch(String(r.CustomerId)).liker = true; });
  subscribers.forEach(function (r) { touch(String(r.CustomerId)).subscriber = true; });
  purchasers.forEach(function (o) { if (o.CustomerId) touch(String(o.CustomerId)).purchaser = true; });

  // Attach only seller-authorised fields (name, masked contact, dates). Never
  // any push token or device data (none is stored on these tabs anyway).
  var custById = {};
  sheetToObjects(getSheet('Customers')).forEach(function (c) { custById[String(c.CustomerId)] = c; });
  var list = Object.keys(byId).map(function (cid) {
    var e = byId[cid]; var c = custById[cid] || {};
    e.name = c.Name || '';
    return e;
  });
  var offset = Math.max(0, parseInt(body && body.offset, 10) || 0);
  var limit = Math.min(200, Math.max(1, parseInt(body && body.limit, 10) || 100));
  return ok({
    counts: { followers: followers.length, likers: likers.length,
      subscribers: subscribers.length, purchasers: Object.keys(byId).filter(function (k) { return byId[k].purchaser; }).length,
      total: list.length },
    audience: list.slice(offset, offset + limit),
    total: list.length
  });
}
