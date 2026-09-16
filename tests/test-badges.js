/**
 * The seller-badge engine: metrics, score, eligibility, overrides, lifecycle.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. A MISSING COMPONENT IS NOT A ZERO. A seller nobody has messaged yet must
 *    not be scored 0 for responsiveness - that measures our data, not them, and
 *    it would make every new seller look like a bad one. Absent components are
 *    dropped and the remaining weights renormalised; a seller with nothing
 *    scorable gets null, which is not a low score.
 *
 * 2. A SELLER CANNOT AWARD THEMSELVES ANYTHING. Every input is a row only a
 *    customer or the system writes. The test feeds seller-controlled fields
 *    (store name, phone, delivery flags) and asserts they change nothing, and
 *    asserts no function in the file reads a request body.
 *
 * 3. BADGES COME OFF AGAIN. The snapshot is rebuilt wholesale, so losing
 *    eligibility removes a badge with no separate removal path - and regaining
 *    it awards it again. Both directions are exercised.
 *
 * 4. AN OVERRIDE NEVER ERASES WHAT THE DATA SAID. The automatic answer is
 *    recorded even when an admin overrules it, so the admin view can show both.
 *
 * 5. NO CUSTOMER EMAIL REACHES THE SNAPSHOT. Repeat customers are counted from
 *    order emails; the addresses themselves must not survive into a row that
 *    feeds a public response.
 */
const fs = require('fs'), vm = require('vm');
const REPO = '/home/user/simple-kiri-shop/';
const code = fs.readFileSync(REPO + 'apps-script/Badges.gs', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

function ctx(opts) {
  opts = opts || {};
  const tabs = {
    Owners: opts.owners || [],
    Orders: opts.orders || [],
    Reviews: opts.reviews || [],
    Messages: opts.messages || [],
    BadgeConfig: opts.config || [],
    SellerBadges: opts.snapshots || []
  };
  const missing = opts.missing || [];
  const appended = [], updated = [], invalidated = [], ensured = [], cleared = [], written = [];
  const cache = {};

  const sandbox = {
    appended, updated, invalidated, ensured, cleared, written, cache, tabs,
    Logger: { log() {} },
    nowIso: () => '2026-09-11T00:00:00.000Z',
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    // A Sheet stub with just enough Range API for the batched snapshot write.
    // cleared/written record what actually reached the spreadsheet.
    getSheet: (n) => {
      if (missing.indexOf(n) !== -1) throw new Error('Sheet tab not found: ' + n);
      return {
        name: n,
        getLastRow: () => (tabs[n] || []).length + 1,
        getRange: (row, col, numRows, numCols) => ({
          clearContent: () => cleared.push({ sheet: n, row, numRows }),
          setValues: (v) => written.push({ sheet: n, row, values: v })
        })
      };
    },
    sheetToObjects: (n) => {
      const key = (n && n.name) ? n.name : n;
      return (tabs[key] || []).map((r, i) => Object.assign({ __row: i + 2 }, r));
    },
    appendRowFromObject: (sheet, obj) => appended.push(Object.assign({ __sheet: sheet }, obj)),
    updateRowFromObject: (sheet, row, obj) => updated.push(Object.assign({ __sheet: sheet, __row: row }, obj)),
    ensureColumn: (sheet, name) => ensured.push(name),
    getHeaders: () => ['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt'],
    sanitizeForSheetCell: (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v),
    invalidateCache: (keys) => keys.forEach((k) => { invalidated.push(k); delete cache[k]; }),
    // A real (tiny) cache, so cache invalidation can be asserted rather than
    // assumed - a stale badge index after an admin verifies a seller is exactly
    // the bug this needs to catch.
    getCached: (key, ttl, producer) => {
      if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
      const v = producer();
      cache[key] = v;
      return v;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const owner = (o) => Object.assign({ OwnerId: 'o1', StoreName: 'Bong', StoreSlug: 'bong',
  Status: 'active', CreatedAt: daysAgo(400) }, o);
const order = (o) => Object.assign({ OwnerId: 'o1', Status: 'Fulfilled',
  CustomerEmail: 'a@x.com', CreatedAt: daysAgo(10) }, o);
const review = (o) => Object.assign({ OwnerId: 'o1', ProductId: 'p1', Rating: 5,
  Status: 'published' }, o);
const msg = (o) => Object.assign({ ConversationId: 'c1', OwnerId: 'o1',
  SenderType: 'customer', CreatedAt: daysAgo(5) }, o);

/* ---------- configuration ---------- */
{
  let s = ctx({ missing: ['BadgeConfig'] });
  const cfg = s.badgeConfig();
  ok('a missing BadgeConfig tab is a working configuration, not an error',
    s.badgeNum(cfg, 'weight.ratings') === 30);
  ok('the six weights are the specified split',
    [30, 20, 15, 15, 10, 10].join() === ['weight.ratings', 'weight.orders',
      'weight.responsiveness', 'weight.fulfilment', 'weight.cancellations',
      'weight.complaints'].map((k) => s.badgeNum(cfg, k)).join());
  ok('New Seller defaults to 30 days', s.badgeNum(cfg, 'newSellerDays') === 30);
  ok('the low-star complaints proxy is OFF by default - we do not measure complaints',
    s.badgeFlag(cfg, 'complaints.useLowStarProxy') === false);
  ok('every badge is enabled by default',
    s.BADGE_IDS.every((id) => s.badgeEnabled(cfg, id)));

  s = ctx({ config: [{ Key: 'newSellerDays', Value: '90' },
                     { Key: 'enabled.popular', Value: 'false' },
                     { Key: 'nonsense.key', Value: 'x' }] });
  const c2 = s.badgeConfig();
  ok('a sheet value overrides the default', s.badgeNum(c2, 'newSellerDays') === 90);
  ok('a badge can be switched off site-wide', s.badgeEnabled(c2, 'popular') === false);
  ok('a key this build does not know is ignored, not invented',
    c2['nonsense.key'] === undefined);

  s = ctx({ config: [{ Key: 'weight.ratings', Value: 'banana' }] });
  ok('an unparseable number falls back to the default rather than becoming NaN',
    s.badgeNum(s.badgeConfig(), 'weight.ratings') === 30);
}

/* ---------- the score: absent is not zero ---------- */
{
  const s = ctx({});
  const cfg = s.badgeConfig();

  ok('a seller with no data at all scores null, not 0',
    s.sellerScore(cfg, null, null, null) === null);

  // Perfect on everything that exists, nothing on what does not.
  const perfectOrders = { total: 25, fulfilled: 25, cancelled: 0 };
  const perfectReviews = { count: 10, average: 5, lowShare: 0 };
  ok('perfect ratings and orders with no message history still scores 100',
    s.sellerScore(cfg, perfectOrders, perfectReviews, null) === 100,
    String(s.sellerScore(cfg, perfectOrders, perfectReviews, null)));

  const slow = { replies: 10, medianMinutes: 24 * 60 };
  ok('and adding a terrible reply time DOES pull it down',
    s.sellerScore(cfg, perfectOrders, perfectReviews, slow) < 100,
    String(s.sellerScore(cfg, perfectOrders, perfectReviews, slow)));

  // The heart of it: an unmeasured component must not read as a failed one.
  const noMessages = s.sellerScore(cfg, perfectOrders, perfectReviews, null);
  const worstMessages = s.sellerScore(cfg, perfectOrders, perfectReviews, slow);
  ok('never having been messaged scores better than answering slowly, as it must',
    noMessages > worstMessages, noMessages + ' vs ' + worstMessages);

  ok('too few reviews means ratings are not scored at all, rather than scored low',
    s.sellerScore(cfg, perfectOrders, { count: 1, average: 1, lowShare: 1 }, null)
      === s.sellerScore(cfg, perfectOrders, null, null));

  // 1 is the floor of the scale, not half marks: the ratings component scores 0,
  // so the seller keeps only the other three components' weight (20+15+10 of 75).
  const oneStar = s.sellerScore(cfg, perfectOrders, { count: 10, average: 1, lowShare: 1 }, null);
  ok('a 1.0 average scores ZERO for ratings, not half marks', oneStar === 60, String(oneStar));
  ok('which is the entire ratings weight lost, renormalised', noMessages - oneStar === 40,
    noMessages + ' - ' + oneStar);

  ok('cancellations drag the score down',
    s.sellerScore(cfg, { total: 20, fulfilled: 10, cancelled: 10 }, perfectReviews, null)
      < s.sellerScore(cfg, { total: 20, fulfilled: 20, cancelled: 0 }, perfectReviews, null));

  ok('orders stuck un-fulfilled hurt too, not just cancelled ones',
    s.sellerScore(cfg, { total: 20, fulfilled: 5, cancelled: 0 }, perfectReviews, null)
      < s.sellerScore(cfg, { total: 20, fulfilled: 20, cancelled: 0 }, perfectReviews, null));

  // The complaints proxy, when someone decides to turn it on.
  const s2 = ctx({ config: [{ Key: 'complaints.useLowStarProxy', Value: 'true' }] });
  const cfg2 = s2.badgeConfig();
  ok('with the proxy on, a pile of 1-2 star reviews lowers the score further',
    s2.sellerScore(cfg2, perfectOrders, { count: 10, average: 3, lowShare: 0.5 }, null)
      < s2.sellerScore(cfg2, perfectOrders, { count: 10, average: 3, lowShare: 0 }, null));
  ok('and with it off (the default) the low-star share changes nothing',
    s.sellerScore(cfg, perfectOrders, { count: 10, average: 3, lowShare: 0.5 }, null)
      === s.sellerScore(cfg, perfectOrders, { count: 10, average: 3, lowShare: 0 }, null));
}

/* ---------- order metrics ---------- */
{
  const s = ctx({ orders: [
    order({ Status: 'Fulfilled', CustomerEmail: 'A@x.com' }),
    order({ Status: 'Fulfilled', CustomerEmail: 'a@x.com' }),
    order({ Status: 'Cancelled', CustomerEmail: 'b@x.com' }),
    order({ Status: 'Paid', CustomerEmail: 'c@x.com' }),
    order({ Status: 'Fulfilled', CustomerEmail: 'd@x.com', CreatedAt: daysAgo(200) })
  ] });
  const m = s.orderMetricsByOwner(s.badgeConfig()).o1;
  ok('every order counts towards the total', m.total === 5, String(m.total));
  ok('fulfilled and cancelled are counted separately',
    m.fulfilled === 3 && m.cancelled === 1, m.fulfilled + '/' + m.cancelled);
  ok('a customer who ordered twice under different capitalisation is ONE customer',
    m.distinctCustomers === 3, String(m.distinctCustomers));
  ok('and counts as a repeat customer', m.repeatCustomers === 1, String(m.repeatCustomers));
  ok('a cancelled order is not "current interest"', m.recent === 3, String(m.recent));
  ok('an order from 200 days ago is not recent either', m.recent === 3);
  ok('NO CUSTOMER EMAIL survives into the metrics',
    JSON.stringify(m).indexOf('@') === -1, JSON.stringify(m));

  ok('a missing Orders tab degrades to no metrics, not a crash',
    JSON.stringify(ctx({ missing: ['Orders'] }).orderMetricsByOwner(ctx({}).badgeConfig())) === '{}');
}

/* ---------- review metrics ---------- */
{
  const s = ctx({ reviews: [
    review({ Rating: 5 }), review({ Rating: 4 }),
    review({ Rating: 1 }), review({ Rating: 2 }),
    review({ Rating: 1, Status: 'hidden' }),
    review({ Rating: 9 })
  ] });
  const m = s.reviewMetricsByOwner().o1;
  ok('hidden reviews are excluded', m.count === 4, String(m.count));
  ok('an out-of-range rating is excluded', m.count === 4);
  ok('the average is over published reviews only', m.average === 3, String(m.average));
  ok('the 1-2 star share is tracked for the optional complaints proxy',
    m.lowShare === 0.5, String(m.lowShare));
  ok('a missing Reviews tab degrades to no metrics',
    JSON.stringify(ctx({ missing: ['Reviews'] }).reviewMetricsByOwner()) === '{}');
}

/* ---------- responsiveness ---------- */
{
  const base = Date.now() - 5 * DAY;
  const at = (mins) => new Date(base + mins * 60000).toISOString();

  // One holiday must not sink an otherwise prompt seller - that is why it is a
  // median and not a mean.
  let s = ctx({ messages: [
    msg({ ConversationId: 'c1', CreatedAt: at(0) }),
    msg({ ConversationId: 'c1', SenderType: 'vendor', CreatedAt: at(10) }),
    msg({ ConversationId: 'c2', CreatedAt: at(0) }),
    msg({ ConversationId: 'c2', SenderType: 'vendor', CreatedAt: at(20) }),
    msg({ ConversationId: 'c3', CreatedAt: at(0) }),
    msg({ ConversationId: 'c3', SenderType: 'vendor', CreatedAt: at(60 * 24 * 9) })
  ] });
  let m = s.responseMetricsByOwner(s.badgeConfig()).o1;
  ok('three replies are counted', m.replies === 3, String(m.replies));
  ok('the MEDIAN ignores the one nine-day outlier a mean would be ruined by',
    m.medianMinutes === 20, String(m.medianMinutes));

  // Three messages in a row is one person waiting once.
  s = ctx({ messages: [
    msg({ CreatedAt: at(0) }), msg({ CreatedAt: at(5) }), msg({ CreatedAt: at(9) }),
    msg({ SenderType: 'vendor', CreatedAt: at(30) })
  ] });
  m = s.responseMetricsByOwner(s.badgeConfig()).o1;
  ok('a customer sending three messages is waiting once, not three times',
    m.replies === 1, String(m.replies));
  ok('and the clock starts at the FIRST of them', m.medianMinutes === 30, String(m.medianMinutes));

  // A seller writing twice has replied once.
  s = ctx({ messages: [
    msg({ CreatedAt: at(0) }),
    msg({ SenderType: 'vendor', CreatedAt: at(10) }),
    msg({ SenderType: 'vendor', CreatedAt: at(12) })
  ] });
  ok('a second vendor message is the same reply continued, not a new one',
    s.responseMetricsByOwner(s.badgeConfig()).o1.replies === 1);

  // A good record last year must not mask neglect now.
  s = ctx({ messages: [
    msg({ CreatedAt: new Date(Date.now() - 300 * DAY).toISOString() }),
    msg({ SenderType: 'vendor', CreatedAt: new Date(Date.now() - 300 * DAY + 60000).toISOString() })
  ] });
  ok('replies outside the window do not count - an old good record is not a current one',
    s.responseMetricsByOwner(s.badgeConfig()).o1 === undefined);

  ok('a missing Messages tab degrades to no metrics',
    JSON.stringify(ctx({ missing: ['Messages'] }).responseMetricsByOwner(ctx({}).badgeConfig())) === '{}');
}

/* ---------- eligibility ---------- */
{
  const s = ctx({});
  const cfg = s.badgeConfig();
  const auto = (o, score, om, rm, sm, pop) =>
    s.autoBadgesFor(cfg, owner(o), score, om, rm, sm, pop || {});

  ok('a store that joined 5 days ago is a New Seller',
    auto({ CreatedAt: daysAgo(5) }, null, null, null, null).badges.indexOf('new') !== -1);
  ok('a store that joined 60 days ago is not',
    auto({ CreatedAt: daysAgo(60) }, null, null, null, null).badges.indexOf('new') === -1);
  ok('A BLANK JOIN DATE IS NOT BRAND NEW - sellers who predate the column keep their badges',
    auto({ CreatedAt: '' }, null, null, null, null).badges.indexOf('new') === -1);
  ok('and neither is an unparseable one',
    auto({ CreatedAt: 'not a date' }, null, null, null, null).badges.indexOf('new') === -1);

  ok('VERIFIED IS NEVER AUTOMATIC - no amount of good data replaces a human check',
    auto({}, 100, { total: 500, fulfilled: 500, cancelled: 0, distinctCustomers: 100, repeatCustomers: 90, recent: 50 },
      { count: 100, average: 5, lowShare: 0 }, { replies: 100, medianMinutes: 1 })
      .badges.indexOf('verified') === -1);

  ok('a fast median reply earns Responsive Seller',
    auto({}, null, null, null, { replies: 10, medianMinutes: 30 }).badges.indexOf('responsive') !== -1);
  ok('a slow one does not',
    auto({}, null, null, null, { replies: 10, medianMinutes: 600 }).badges.indexOf('responsive') === -1);
  ok('and neither does a fast one over too few replies to mean anything',
    auto({}, null, null, null, { replies: 2, medianMinutes: 1 }).badges.indexOf('responsive') === -1);

  ok('a 95% fulfilment record over 20 orders earns Reliable Delivery',
    auto({}, null, { total: 20, fulfilled: 19, cancelled: 1 }, null, null).badges.indexOf('delivery') !== -1);
  ok('a 50% record does not',
    auto({}, null, { total: 20, fulfilled: 10, cancelled: 10 }, null, null).badges.indexOf('delivery') === -1);
  ok('and a perfect record over two orders is not a record',
    auto({}, null, { total: 2, fulfilled: 2, cancelled: 0 }, null, null).badges.indexOf('delivery') === -1);

  const loyal = { total: 20, fulfilled: 20, cancelled: 0, distinctCustomers: 10, repeatCustomers: 5, recent: 5 };
  ok('half the customers coming back, with good ratings, earns Customer Favourite',
    auto({}, null, loyal, { count: 10, average: 4.5, lowShare: 0 }, null).badges.indexOf('favourite') !== -1);
  ok('but not with poor ratings',
    auto({}, null, loyal, { count: 10, average: 2, lowShare: 0.5 }, null).badges.indexOf('favourite') === -1);
  ok('and not without enough reviews to judge',
    auto({}, null, loyal, { count: 1, average: 5, lowShare: 0 }, null).badges.indexOf('favourite') === -1);

  const strong = { total: 30, fulfilled: 30, cancelled: 0, distinctCustomers: 20, repeatCustomers: 8, recent: 12 };
  const good = { count: 20, average: 4.8, lowShare: 0 };
  ok('a high score with a real track record earns Top Seller',
    auto({}, 90, strong, good, null).badges.indexOf('top') !== -1);
  ok('a high score over too few orders does NOT - a perfect ratio on two sales is not a record',
    auto({}, 100, { total: 2, fulfilled: 2, cancelled: 0 }, good, null).badges.indexOf('top') === -1);
  ok('a high score with too few reviews does not either',
    auto({}, 100, strong, { count: 1, average: 5, lowShare: 0 }, null).badges.indexOf('top') === -1);
  ok('a mediocre score does not, however many orders',
    auto({}, 60, strong, good, null).badges.indexOf('top') === -1);

  ok('a very high score plus volume plus ratings earns Mwakete Recommended',
    auto({}, 95, strong, good, null).badges.indexOf('recommended') !== -1);
  ok('a Top Seller score is not enough for Recommended',
    auto({}, 80, strong, good, null).badges.indexOf('recommended') === -1);

  ok('being in the busy set earns Popular Seller',
    auto({}, null, { total: 5, fulfilled: 5, cancelled: 0, recent: 5 }, null, null, { o1: true })
      .badges.indexOf('popular') !== -1);
  ok('and not being in it does not',
    auto({}, null, { total: 5, fulfilled: 5, cancelled: 0, recent: 5 }, null, null, {})
      .badges.indexOf('popular') === -1);

  ok('every award records WHY, for the admin view',
    !!auto({}, 95, strong, good, null).why.recommended);
}

/* ---------- popularity is relative ---------- */
{
  const s = ctx({});
  const cfg = s.badgeConfig();
  // All ten clear the minimum, so the top-fifth slice is over ten, not over
  // however many happened to survive the floor.
  const metrics = {};
  for (let i = 1; i <= 10; i++) metrics['o' + i] = { recent: i + 2 };
  const set = s.popularOwnerSet(cfg, metrics);
  ok('the top fifth of busy stores are Popular', Object.keys(set).length === 2,
    Object.keys(set).join(','));
  ok('and it is the BUSIEST two', !!set.o10 && !!set.o9, Object.keys(set).join(','));
  // The floor runs first, so quiet stores are excluded before the slice is cut.
  const withFloor = {};
  for (let i = 1; i <= 10; i++) withFloor['o' + i] = { recent: i };
  ok('stores below the floor are dropped BEFORE the top fifth is measured',
    Object.keys(s.popularOwnerSet(cfg, withFloor)).join(',') === 'o10',
    Object.keys(s.popularOwnerSet(cfg, withFloor)).join(','));

  ok('a store below the floor cannot be Popular however quiet everyone else is',
    Object.keys(s.popularOwnerSet(cfg, { o1: { recent: 1 }, o2: { recent: 2 } })).length === 0);
  ok('with three qualifying stores the busiest is still named, not rounded away',
    Object.keys(s.popularOwnerSet(cfg, { o1: { recent: 3 }, o2: { recent: 9 }, o3: { recent: 4 } }))
      .join() === 'o2');
  ok('no orders anywhere means nobody is Popular',
    Object.keys(s.popularOwnerSet(cfg, {})).length === 0);
}

/* ---------- overrides ---------- */
{
  const s = ctx({});
  const cfg = s.badgeConfig();

  let r = s.applyBadgeOverrides(cfg, owner({ BadgeVerified: 'true' }), ['top']);
  ok('an admin can grant Verified', r.badges.indexOf('verified') !== -1, r.badges.join(','));
  ok('and it is recorded as an admin decision, not as earned',
    r.source.verified === 'admin' && r.source.top === 'auto', JSON.stringify(r.source));
  ok('badges come back in priority order', r.badges.join(',') === 'top,verified', r.badges.join(','));

  r = s.applyBadgeOverrides(cfg, owner({ BadgeRecommended: 'true' }), []);
  ok('an admin can grant Mwakete Recommended with no automatic eligibility',
    r.badges.join(',') === 'recommended' && r.source.recommended === 'admin');

  r = s.applyBadgeOverrides(cfg, owner({ BadgeRecommended: 'false' }), ['recommended', 'top']);
  ok('and can revoke it even when the data says yes',
    r.badges.join(',') === 'top', r.badges.join(','));

  r = s.applyBadgeOverrides(cfg, owner({ BadgeSuppressed: 'true', BadgeVerified: 'true' }),
    ['recommended', 'top']);
  ok('suppressing a store removes EVERYTHING, including an admin grant',
    r.badges.length === 0 && r.suppressed === true, r.badges.join(','));

  const off = ctx({ config: [{ Key: 'enabled.top', Value: 'false' }] });
  r = off.applyBadgeOverrides(off.badgeConfig(), owner({}), ['top', 'delivery']);
  ok('a badge switched off site-wide stops appearing', r.badges.join(',') === 'delivery');

  const offV = ctx({ config: [{ Key: 'enabled.verified', Value: 'false' }] });
  r = offV.applyBadgeOverrides(offV.badgeConfig(), owner({ BadgeVerified: 'true' }), []);
  ok('and switching one off beats an admin grant of it', r.badges.length === 0);

  // The whole point of keeping both.
  ok('THE AUTOMATIC ANSWER IS KEPT even when an admin overrules it',
    (function () {
      const snap = ctx({
        owners: [owner({ BadgeRecommended: 'false' })],
        orders: Array.from({ length: 30 }, (_, i) => order({ CustomerEmail: 'c' + (i % 12) + '@x.com' })),
        reviews: Array.from({ length: 20 }, () => review({ Rating: 5 }))
      }).computeSellerBadgeSnapshots()[0];
      return snap.reason.auto.indexOf('recommended') !== -1
        && snap.badges.indexOf('recommended') === -1;
    })());
}

/* ---------- the snapshot, and the lifecycle ---------- */
{
  const goodOrders = Array.from({ length: 30 }, (_, i) =>
    order({ CustomerEmail: 'c' + (i % 12) + '@x.com' }));
  const goodReviews = Array.from({ length: 20 }, () => review({ Rating: 5 }));

  let s = ctx({ owners: [owner({})], orders: goodOrders, reviews: goodReviews });
  let snap = s.computeSellerBadgeSnapshots()[0];
  ok('a strong seller is awarded Recommended and Top',
    snap.badges.indexOf('recommended') !== -1 && snap.badges.indexOf('top') !== -1,
    snap.badges.join(','));
  ok('with a score recorded for the admin view', snap.score >= 88, String(snap.score));
  ok('NO CUSTOMER EMAIL reaches the snapshot',
    JSON.stringify(snap).indexOf('@') === -1);

  // Same seller, performance collapses.
  const badOrders = goodOrders.concat(Array.from({ length: 40 }, (_, i) =>
    order({ Status: 'Cancelled', CustomerEmail: 'z' + i + '@x.com' })));
  s = ctx({ owners: [owner({})], orders: badOrders,
            reviews: goodReviews.concat(Array.from({ length: 30 }, () => review({ Rating: 1 }))) });
  snap = s.computeSellerBadgeSnapshots()[0];
  ok('LOSING ELIGIBILITY REMOVES THE BADGES - nothing is permanent',
    snap.badges.indexOf('recommended') === -1 && snap.badges.indexOf('top') === -1,
    snap.badges.join(','));

  // And back again.
  s = ctx({ owners: [owner({})], orders: goodOrders, reviews: goodReviews });
  ok('and recovering performance awards them again - no seller is locked out',
    s.computeSellerBadgeSnapshots()[0].badges.indexOf('recommended') !== -1);

  // Writing.
  s = ctx({ owners: [owner({ OwnerId: 'o1' }), owner({ OwnerId: 'o2', CreatedAt: daysAgo(3) })],
            orders: goodOrders, reviews: goodReviews,
            snapshots: [{ OwnerId: 'o1', Badges: 'stale' }] });
  const n = s.recomputeSellerBadges();
  ok('every seller is written', n === 2, String(n));
  // ONE round trip for the whole tab. Row-at-a-time would be 200 setValues
  // calls on a 200-seller marketplace, inside a trigger Apps Script kills at
  // six minutes.
  ok('the whole tab is written in a SINGLE setValues call, not one per seller',
    s.written.length === 1 && s.written[0].values.length === 2,
    JSON.stringify(s.written.map((w) => w.values.length)));
  ok('and the old rows are cleared first, so a removed seller does not linger',
    s.cleared.length === 1 && s.cleared[0].row === 2);
  ok('no row-at-a-time writes remain', s.updated.length === 0 && s.appended.length === 0);

  const rows = s.written[0].values;
  const byOwner = {};
  rows.forEach((r) => { byOwner[r[0]] = r; });
  ok('both sellers are in that one write', !!byOwner.o1 && !!byOwner.o2,
    Object.keys(byOwner).join(','));
  ok('the new seller is badged as one', /\bnew\b/.test(byOwner.o2[1]), byOwner.o2[1]);
  ok('a seller with nothing scorable stores a blank score, NOT a zero',
    byOwner.o2[2] === '', JSON.stringify(byOwner.o2[2]));
  ok('columns are addressed by header name, so reordering the tab cannot scramble them',
    byOwner.o1[0] === 'o1' && /^[\w,]*$/.test(byOwner.o1[1]) && byOwner.o1[4].indexOf('{') === 0,
    JSON.stringify(byOwner.o1.slice(0, 3)));
  ok('NO CUSTOMER EMAIL is written to the sheet either',
    JSON.stringify(rows).indexOf('@') === -1);
  ok('the override columns are ensured before writing, so an old sheet still works',
    s.ensured.join(',') === 'BadgeVerified,BadgeRecommended,BadgeSuppressed', s.ensured.join(','));
  ok('and the caches are dropped, or an admin\'s change would not show for 10 minutes',
    s.invalidated.indexOf('v1:sellerBadges') !== -1
    && s.invalidated.indexOf('v1:badgeConfig') !== -1, s.invalidated.join(','));
}

/* ---------- the read path ---------- */
{
  let s = ctx({ missing: ['SellerBadges'] });
  ok('a missing snapshot tab means a page with no badges, not a broken marketplace',
    JSON.stringify(s.sellerBadgeIndex()) === '{}');

  s = ctx({ snapshots: [
    { OwnerId: 'o1', Badges: 'recommended,verified' },
    { OwnerId: 'o2', Badges: '' },
    { OwnerId: 'o3', Badges: 'top, delivery ' },
    { OwnerId: '', Badges: 'top' },
    { OwnerId: 'o4', Badges: 'sponsored,<script>,top' }
  ] });
  const idx = s.sellerBadgeIndex();
  ok('badges are read back per seller', idx.o1.join(',') === 'recommended,verified');
  ok('a seller with none is left out entirely', idx.o2 === undefined);
  ok('stray whitespace from a hand-edited cell is tolerated',
    idx.o3.join(',') === 'top,delivery', String(idx.o3));
  ok('a row with no owner id is skipped', Object.keys(idx).indexOf('') === -1);
  ok('A HAND-EDITED CELL CANNOT PUT AN ARBITRARY STRING INTO A CUSTOMER RESPONSE',
    idx.o4.join(',') === 'top', String(idx.o4));
  ok('and that includes inventing a "sponsored" badge', idx.o4.indexOf('sponsored') === -1);
}

/* ---------- nothing a seller controls changes anything ---------- */
{
  const base = { owners: [owner({})], orders: [], reviews: [], messages: [] };
  const clean = ctx(base).computeSellerBadgeSnapshots()[0];
  const tampered = ctx(Object.assign({}, base, { owners: [owner({
    StoreName: 'Mwakete Recommended',
    Phone: 'recommended',
    Status: 'active',
    Visits: 999999,
    DeliveryTruck: 'true',
    // The fields an admin controls, spelled the way a seller might guess.
    badgeVerified: 'true',
    BADGEVERIFIED: 'true',
    Badges: 'recommended,top,verified'
  })] })).computeSellerBadgeSnapshots()[0];
  ok('a seller cannot award themselves a badge through any field they can edit',
    JSON.stringify(clean.badges) === JSON.stringify(tampered.badges),
    JSON.stringify(tampered.badges));
  ok('not even by writing one into a Badges column on their own row',
    tampered.badges.length === 0, JSON.stringify(tampered.badges));
}

/* ---------- read from the source ---------- */
{
  // Comments stripped first. The previous version of this matched the word
  // "body" inside the file's OWN comment saying there is no request body, and
  // reported a violation where there was none.
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('nothing in this file reads a request body - there is no customer input path',
    !/\bbody\b/.test(bare) && !/\bparams\b/.test(bare));
  ok('and nothing here writes to Orders, Reviews, Messages or Customers',
    !/updateRowFromObject\(\s*getSheet\('(Orders|Reviews|Messages|Customers)'/.test(code)
    && !/appendRowFromObject\(\s*getSheet\('(Orders|Reviews|Messages|Customers)'/.test(code));
  ok('the trigger installer is editor-only, never routed',
    /Deliberately not reachable from doGet\/doPost/.test(code));

  // The drift guard: the two id lists must agree.
  const js = fs.readFileSync(REPO + 'assets/js/badges.js', 'utf8');
  const gsIds = (code.match(/var BADGE_IDS = \[([^\]]+)\]/) || [])[1];
  const jsIds = (js.match(/const SELLER_BADGE_ORDER = \[([\s\S]*?)\]/) || [])[1];
  const norm = (s) => (s || '').replace(/['\s\n]/g, '').split(',').filter(Boolean).join(',');
  ok('THE BACKEND AND FRONTEND BADGE IDS MATCH, in the same priority order',
    norm(gsIds) === norm(jsIds), norm(gsIds) + '  vs  ' + norm(jsIds));
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
