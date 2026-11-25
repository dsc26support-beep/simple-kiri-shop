/**
 * CESN Stage 2 - Engagement.gs harness. Pure Node vm with in-memory "sheets",
 * no Google APIs (same approach as test-checksetup.js). Proves the three
 * relationships stay independent, consent is explicit, counts/notifications
 * behave, and cross-store / auth isolation holds.
 */
const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Engagement.gs', 'utf8');

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); } };

// Fresh sandbox + in-memory tables for each scenario, so tests never bleed.
function makeEnv(seed) {
  const tables = Object.assign({
    StoreFollows: [], StoreLikes: [], StoreMarketingConsents: [], Notifications: [],
    Owners: [
      { OwnerId: 'own_A', StoreSlug: 'store-a', StoreName: 'Store A', LogoUrl: 'a.png', Island: 'Tarawa', Village: 'Betio' },
      { OwnerId: 'own_B', StoreSlug: 'store-b', StoreName: 'Store B', LogoUrl: '', Island: '', Village: '' }
    ],
    Customers: [
      { CustomerId: 'cus_1', Name: 'Aroita', Email: 'aroita@example.com' },
      { CustomerId: 'cus_2', Name: 'Teaero', Email: 'teaero@example.com' }
    ],
    Orders: []
  }, seed || {});
  let n = 0;
  const sessions = { 'tok1': 'cus_1', 'tok2': 'cus_2' };            // customer tokens
  const ownerSessions = { 'own-a-tok': 'own_A', 'own-b-tok': 'own_B' };
  const sandbox = {
    encodeURIComponent,
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: String(e) }),
    newId: (p) => p + '_' + (++n),
    nowIso: () => new Date(2026, 10, 25, 0, 0, n).toISOString(),  // monotonic-ish for ordering
    publicErrorMessage: (e) => (e && e.message) || String(e),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    getSheet: (name) => { if (!(name in tables)) throw new Error('Sheet tab not found: ' + name); return name; },
    sheetToObjects: (name) => tables[name].map((r, i) => { r.__row = i; return r; }),
    appendRowFromObject: (name, obj) => { tables[name].push(Object.assign({}, obj)); },
    updateRowFromObject: (name, row, patch) => { Object.assign(tables[name][row], patch); },
    getOwnerBySlug: (slug) => tables.Owners.filter((o) => o.StoreSlug === slug)[0] || null,
    requireCustomerAuth: (tok) => { const id = sessions[tok]; if (!id) throw new Error('Not signed in'); return tables.Customers.filter((c) => c.CustomerId === id)[0]; },
    requireAuth: (tok) => { const id = ownerSessions[tok]; if (!id) throw new Error('Not authenticated'); return tables.Owners.filter((o) => o.OwnerId === id)[0]; }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, tables };
}
// Mirror doPost's outer try/catch: a thrown error becomes a fail() response,
// exactly as the live router converts it.
const call = (env, fn, body) => {
  try { return vm.runInContext('(' + fn + ')', env.sandbox)(body); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
};
const callOwner = (env, fn, ownerTok, body) => {
  try {
    const owner = env.sandbox.requireAuth(ownerTok);
    return vm.runInContext('(' + fn + ')', env.sandbox)(owner, body);
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
};

/* ---- Follow ---- */
{
  const env = makeEnv();
  let r = call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  t('follow: ok, following true, 1 follower', r.ok && r.following === true && r.followers === 1, JSON.stringify(r));
  t('follow: a welcome notification was seeded (in-app)', env.tables.Notifications.length === 1 && env.tables.Notifications[0].Category === 'store_follow');
  t('follow: following does NOT create a like', env.tables.StoreLikes.length === 0 && r.liked === false);
  // idempotent
  r = call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  t('follow again: still 1 follower (no duplicate row)', r.followers === 1 && env.tables.StoreFollows.filter((x) => x.Status === 'active').length === 1);
  t('follow again: no second welcome notification', env.tables.Notifications.length === 1);
  // unfollow
  r = call(env, 'actionUnfollowStore', { token: 'tok1', storeSlug: 'store-a' });
  t('unfollow: following false, 0 followers', r.following === false && r.followers === 0);
  t('unfollow: row kept with Status removed (not deleted)', env.tables.StoreFollows.length === 1 && env.tables.StoreFollows[0].Status === 'removed');
  // re-follow reactivates, no new welcome
  r = call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  t('re-follow: reactivates same row, still 1 row', env.tables.StoreFollows.length === 1 && r.followers === 1);
  t('re-follow: no new welcome (not the first-ever follow)', env.tables.Notifications.length === 1);
}

/* ---- Like is independent of Follow ---- */
{
  const env = makeEnv();
  let r = call(env, 'actionLikeStore', { token: 'tok1', storeSlug: 'store-a' });
  t('like: liked true, 1 like, following still false', r.liked === true && r.likes === 1 && r.following === false);
  t('like: liking does NOT create a follow', env.tables.StoreFollows.length === 0);
  t('like: liking does NOT seed a notification', env.tables.Notifications.length === 0);
  r = call(env, 'actionUnlikeStore', { token: 'tok1', storeSlug: 'store-a' });
  t('unlike: liked false, 0 likes', r.liked === false && r.likes === 0);
}

/* ---- Purchase is NOT consent ---- */
{
  const env = makeEnv({ Orders: [{ OrderId: 'o1', OwnerId: 'own_A', CustomerId: 'cus_1' }] });
  const r = call(env, 'actionGetStoreEngagement', { token: 'tok1', storeSlug: 'store-a' });
  t('purchaser has NO marketing consent by default', r.consent === false);
  t('purchaser is not auto-followed or auto-liked', r.following === false && r.liked === false);
}

/* ---- Per-store consent: explicit opt-in, withdrawal keeps history ---- */
{
  const env = makeEnv();
  let r = call(env, 'actionSetStoreMarketingConsent', { token: 'tok1', storeSlug: 'store-a', optIn: false });
  t('consent: a non-true value never opts in', r.consent === false && env.tables.StoreMarketingConsents.length === 0);
  r = call(env, 'actionSetStoreMarketingConsent', { token: 'tok1', storeSlug: 'store-a', optIn: true });
  t('consent: explicit opt-in records active + OptInAt', r.consent === true && env.tables.StoreMarketingConsents[0].Status === 'active' && !!env.tables.StoreMarketingConsents[0].OptInAt);
  r = call(env, 'actionGetStoreEngagement', { token: 'tok1', storeSlug: 'store-a' });
  t('consent: reflected in engagement state', r.consent === true);
  r = call(env, 'actionSetStoreMarketingConsent', { token: 'tok1', storeSlug: 'store-a', optIn: false });
  t('consent: withdrawal flips to withdrawn + WithdrawnAt, row kept (history)',
    r.consent === false && env.tables.StoreMarketingConsents.length === 1 && env.tables.StoreMarketingConsents[0].Status === 'withdrawn' && !!env.tables.StoreMarketingConsents[0].WithdrawnAt);
  r = call(env, 'actionSetStoreMarketingConsent', { token: 'tok1', storeSlug: 'store-a', optIn: true });
  t('consent: re-opt-in reactivates the same row (no pile-up)', r.consent === true && env.tables.StoreMarketingConsents.length === 1 && env.tables.StoreMarketingConsents[0].Status === 'active');
}

/* ---- Public counts vs personal state ---- */
{
  const env = makeEnv();
  call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  call(env, 'actionLikeStore', { token: 'tok2', storeSlug: 'store-a' });
  let r = call(env, 'actionGetStoreEngagement', { storeSlug: 'store-a' });            // no token
  t('public: counts returned without a token', r.ok && r.followers === 1 && r.likes === 1 && r.signedIn === undefined);
  t('public: no personal state without a token', r.following === undefined && r.consent === undefined);
  r = call(env, 'actionGetStoreEngagement', { token: 'tok2', storeSlug: 'store-a' });
  t('signed in: personal state present', r.signedIn === true && r.liked === true && r.following === false);
  r = call(env, 'actionGetStoreEngagement', { token: 'bad-token', storeSlug: 'store-a' });
  t('bad token: counts still public, no personal state', r.followers === 1 && r.following === undefined);
}

/* ---- Favourite Stores + per-store notify toggle ---- */
{
  const env = makeEnv();
  call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  call(env, 'actionSetStoreMarketingConsent', { token: 'tok1', storeSlug: 'store-a', optIn: true });
  let r = call(env, 'actionGetFavouriteStores', { token: 'tok1' });
  t('favourites: the followed store appears with name + consent + notifyOn',
    r.stores.length === 1 && r.stores[0].storeSlug === 'store-a' && r.stores[0].storeName === 'Store A' && r.stores[0].consent === true && r.stores[0].notifyOn === true);
  call(env, 'actionSetStoreNotifyPreference', { token: 'tok1', storeSlug: 'store-a', notifyOn: false });
  r = call(env, 'actionGetFavouriteStores', { token: 'tok1' });
  t('favourites: per-store notify toggle is honoured', r.stores[0].notifyOn === false);
  call(env, 'actionUnfollowStore', { token: 'tok1', storeSlug: 'store-a' });
  r = call(env, 'actionGetFavouriteStores', { token: 'tok1' });
  t('favourites: an unfollowed store drops off the list', r.stores.length === 0);
}

/* ---- Notification centre ---- */
{
  const env = makeEnv();
  call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  let r = call(env, 'actionGetNotifications', { token: 'tok1' });
  t('notifications: the welcome note is listed, unread = 1', r.notifications.length === 1 && r.unread === 1 && r.notifications[0].read === false);
  const id = r.notifications[0].id;
  r = call(env, 'actionMarkNotificationRead', { token: 'tok1', notificationId: id });
  t('notifications: marking read drops the unread count', r.unread === 0 && r.notifications[0].read === true);
  // a second customer never sees the first customer's notifications
  r = call(env, 'actionGetNotifications', { token: 'tok2' });
  t('notifications: scoped to the signed-in customer only', r.notifications.length === 0);
}

/* ---- Cross-store isolation ---- */
{
  const env = makeEnv();
  call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });
  const rb = call(env, 'actionGetStoreEngagement', { storeSlug: 'store-b' });
  t('isolation: following store A does not change store B counts', rb.followers === 0 && rb.likes === 0);
}

/* ---- Auth + bad input ---- */
{
  const env = makeEnv();
  t('auth: follow without a token fails', call(env, 'actionFollowStore', { storeSlug: 'store-a' }).ok === false);
  t('input: an unknown store slug fails', call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'nope' }).ok === false);
  t('input: a missing slug fails', call(env, 'actionGetStoreEngagement', { token: 'tok1' }).ok === false);
}

/* ---- Seller audiences (owner-authed, de-duplicated, own store only) ---- */
{
  const env = makeEnv({ Orders: [
    { OrderId: 'o1', OwnerId: 'own_A', CustomerId: 'cus_2' },
    { OrderId: 'o2', OwnerId: 'own_B', CustomerId: 'cus_1' }   // belongs to store B, must not appear for A
  ] });
  call(env, 'actionFollowStore', { token: 'tok1', storeSlug: 'store-a' });              // cus_1 follows A
  call(env, 'actionLikeStore', { token: 'tok1', storeSlug: 'store-a' });                // cus_1 also likes A
  call(env, 'actionSetStoreMarketingConsent', { token: 'tok2', storeSlug: 'store-a', optIn: true }); // cus_2 subscribes to A
  const r = callOwner(env, 'actionGetStoreEngagementAudiences', 'own-a-tok', {});
  t('seller: counts correct (1 follower, 1 liker, 1 subscriber, 1 purchaser)',
    r.counts.followers === 1 && r.counts.likers === 1 && r.counts.subscribers === 1 && r.counts.purchasers === 1, JSON.stringify(r.counts));
  const byId = {}; r.audience.forEach((a) => { byId[a.customerId] = a; });
  t('seller: cus_1 is one row flagged follower+liker (no duplicate records)',
    r.audience.filter((a) => a.customerId === 'cus_1').length === 1 && byId.cus_1.follower && byId.cus_1.liker && !byId.cus_1.purchaser);
  t('seller: cus_2 is subscriber + purchaser (ordered from A)', byId.cus_2 && byId.cus_2.subscriber && byId.cus_2.purchaser && !byId.cus_2.follower);
  t('seller: names attached, no device/push fields leaked',
    byId.cus_1.name === 'Aroita' && !('FcmToken' in byId.cus_1) && !('token' in byId.cus_1));
  // store B owner sees only its own: cus_1 purchased from B, nobody engaged B
  const rb = callOwner(env, 'actionGetStoreEngagementAudiences', 'own-b-tok', {});
  t('seller: store B sees only its own purchaser, not A’s audience',
    rb.counts.followers === 0 && rb.counts.likers === 0 && rb.counts.subscribers === 0 && rb.counts.purchasers === 1 && rb.audience[0].customerId === 'cus_1');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
