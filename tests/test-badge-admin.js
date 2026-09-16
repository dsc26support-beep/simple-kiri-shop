/**
 * The admin badge actions.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. NON-ADMINS GET NOTHING. Every action here is reachable by any logged-in
 *    STORE OWNER - the router authenticates the token and then hands the owner
 *    to the action. The isOwnerAdmin gate is the only thing between an ordinary
 *    seller and the ability to grant themselves Mwakete Recommended. Each of the
 *    four actions is called as a plain owner and must refuse.
 *
 * 2. THE REQUEST BODY NEVER REACHES A COLUMN NAME OR A SETTING NAME. `field` is
 *    looked up in a fixed map and `key` must already exist in the defaults, so
 *    no body can write to an arbitrary Owners column or invent a setting.
 *
 * 3. AN OVERRIDE HAS THREE STATES, NOT TWO. Granted, removed, and "leave it to
 *    the data". Without the third there is no way to undo an override - clearing
 *    it would silently mean "no".
 *
 * 4. A CHANGE TAKES EFFECT IMMEDIATELY. An admin who verifies a seller and
 *    cannot then see it has no way to tell a slow system from a broken one, so
 *    every write recomputes and drops the caches.
 */
const fs = require('fs'), vm = require('vm');
const REPO = '/home/user/simple-kiri-shop/';
const admin = fs.readFileSync(REPO + 'apps-script/Admin.gs', 'utf8');
const badges = fs.readFileSync(REPO + 'apps-script/Badges.gs', 'utf8');
const codeGs = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

const ADMIN = { OwnerId: 'a1', Email: 'boss@mwakete.com', StoreSlug: 'boss' };
const SELLER = { OwnerId: 'o1', Email: 'seller@example.com', StoreSlug: 'bong' };

const OWNERS = [
  { OwnerId: 'o1', StoreName: 'Bong', StoreSlug: 'bong', Status: 'active',
    CreatedAt: '2024-01-01T00:00:00Z', BadgeVerified: '', BadgeRecommended: '', BadgeSuppressed: '' },
  { OwnerId: 'o2', StoreName: 'Tabon', StoreSlug: 'tabon', Status: 'active',
    CreatedAt: '2024-01-01T00:00:00Z', BadgeVerified: 'true', BadgeRecommended: 'false', BadgeSuppressed: '' }
];
const SNAPSHOTS = [
  { OwnerId: 'o1', Badges: 'top,delivery', Score: 80,
    MetricsJson: JSON.stringify({ orders: 30, fulfilled: 29, cancelled: 1, reviews: 12, rating: 4.6,
                                  medianReplyMinutes: 40, repeatCustomers: 6, customers: 20 }),
    ReasonJson: JSON.stringify({ auto: ['top', 'delivery'], why: { top: 'Score 80' },
                                 source: { top: 'auto', delivery: 'auto' }, suppressed: false }),
    UpdatedAt: '2026-09-10T00:00:00Z' },
  { OwnerId: 'o2', Badges: 'verified', Score: 91,
    MetricsJson: JSON.stringify({ orders: 40, fulfilled: 40, cancelled: 0, reviews: 20, rating: 4.9 }),
    ReasonJson: JSON.stringify({ auto: ['recommended'], why: { recommended: 'Score 91' },
                                 source: { verified: 'admin' }, suppressed: false }),
    UpdatedAt: '2026-09-10T00:00:00Z' }
];

function ctx(opts) {
  opts = opts || {};
  const tabs = {
    Owners: JSON.parse(JSON.stringify(opts.owners || OWNERS)),
    SellerBadges: opts.noSnapshotTab ? null : JSON.parse(JSON.stringify(opts.snapshots || SNAPSHOTS)),
    BadgeConfig: opts.config || [],
    Featured: [], Products: [], Orders: [], Reviews: [], Messages: []
  };
  const updated = [], appended = [], invalidated = [], recomputes = [];

  const sandbox = {
    updated, appended, invalidated, recomputes, tabs,
    Logger: { log() {} },
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: String(e) }),
    nowIso: () => '2026-09-16T00:00:00.000Z',
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    escapeHtmlForEmail: (v) => v,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'boss@mwakete.com' }) },
    getSheet: (n) => {
      if (n === 'SellerBadges' && tabs.SellerBadges === null) throw new Error('Sheet tab not found: SellerBadges');
      return n;
    },
    sheetToObjects: (n) => (tabs[n] || []).map((r, i) => Object.assign({ __row: i + 2 }, r)),
    findRowById: (sheet, field, val) => {
      const rows = (tabs[sheet] || []).map((r, i) => Object.assign({ __row: i + 2 }, r));
      return rows.filter((r) => String(r[field]) === String(val))[0] || null;
    },
    updateRowFromObject: (sheet, row, obj) => {
      updated.push({ sheet, row, obj });
      Object.assign(tabs[sheet][row - 2], obj);
    },
    appendRowFromObject: (sheet, obj) => { appended.push({ sheet, obj }); tabs[sheet].push(obj); },
    invalidateCache: (keys) => keys.forEach((k) => invalidated.push(k)),
    getCached: (key, ttl, producer) => producer(),
    // Badges.gs defines the real ensureBadgeColumns, which calls this.
    ensureColumn: () => {},
    // Stubbed so the test can assert the admin write triggers a rebuild without
    // re-running the whole engine (that has its own suite).
    recomputeSellerBadges: () => { recomputes.push(1); return tabs.Owners.length; },
    BADGE_IDS: ['recommended', 'top', 'verified', 'responsive', 'delivery', 'favourite', 'popular', 'new'],
    BADGE_CONFIG_DEFAULTS: null,      // filled from Badges.gs below
    badgeConfig: null,
    getOwnerBySlug: () => null,
    isStoreBrowsable: () => true,
    deliveryCostOf: (v) => v,
    unavailableProductIdsToday: () => ({})
  };
  vm.createContext(sandbox);
  // Only the configuration half of Badges.gs is needed; running the whole file
  // gives the real BADGE_CONFIG_DEFAULTS rather than a copy that could drift.
  vm.runInContext(badges, sandbox);
  sandbox.recomputeSellerBadges = () => { recomputes.push(1); return tabs.Owners.length; };
  vm.runInContext(admin, sandbox);
  return sandbox;
}

/* ---------- authorisation ---------- */
{
  const s = ctx();
  const calls = [
    ['actionListSellerBadges', (f) => s[f](SELLER, {})],
    ['actionSetSellerBadgeOverride', (f) => s[f](SELLER, { ownerId: 'o1', field: 'verified', value: 'true' })],
    ['actionSetBadgeConfig', (f) => s[f](SELLER, { key: 'newSellerDays', value: '90' })],
    ['actionRecomputeBadges', (f) => s[f](SELLER)]
  ];
  calls.forEach(([name, run]) => {
    const r = run(name);
    ok('an ordinary store owner cannot call ' + name,
      r.ok === false && /Not authorized/.test(r.error), JSON.stringify(r));
  });
  ok('and a non-admin write changed NOTHING - no row touched, no recompute',
    s.updated.length === 0 && s.appended.length === 0 && s.recomputes.length === 0);

  // The gate is the only thing between a seller and their own badges.
  const r = s.actionSetSellerBadgeOverride(SELLER, { ownerId: SELLER.OwnerId, field: 'recommended', value: 'true' });
  ok('A SELLER CANNOT GRANT THEMSELVES MWAKETE RECOMMENDED', r.ok === false);
  ok('nor with no owner object at all',
    s.actionListSellerBadges(null, {}).ok === false);
  ok('nor with an owner that has no email',
    s.actionListSellerBadges({ OwnerId: 'x' }, {}).ok === false);
}

/* ---------- the admin view ---------- */
{
  const s = ctx();
  const r = s.actionListSellerBadges(ADMIN, {});
  ok('an admin gets every store', r.ok && r.sellers.length === 2, String(r.sellers && r.sellers.length));

  const byId = {};
  r.sellers.forEach((x) => { byId[x.ownerId] = x; });

  ok('with the score, which a customer response never carries', byId.o1.score === 80);
  ok('and the figures behind it', byId.o1.metrics.orders === 30 && byId.o1.metrics.rating === 4.6);
  ok('and the sentence explaining why each badge was awarded', byId.o1.why.top === 'Score 80');
  ok('and whether each badge was earned or granted',
    byId.o1.source.top === 'auto' && byId.o2.source.verified === 'admin',
    JSON.stringify([byId.o1.source, byId.o2.source]));

  // The case an admin most needs spelled out.
  ok('a badge the data says was EARNED but an override hides is still reported',
    byId.o2.autoBadges.indexOf('recommended') !== -1
    && byId.o2.badges.indexOf('recommended') === -1,
    JSON.stringify([byId.o2.autoBadges, byId.o2.badges]));

  ok('the stored override cells are returned, not inferred from the result',
    byId.o2.overrides.verified === 'true' && byId.o2.overrides.recommended === 'false',
    JSON.stringify(byId.o2.overrides));

  ok('the most decorated store is listed first', r.sellers[0].ownerId === 'o1',
    r.sellers.map((x) => x.ownerId).join(','));
  ok('the configuration comes with it, so the settings panel needs no second call',
    r.config && r.config['weight.ratings'] === '30');
  ok('and the badge id list, so the admin page cannot drift from the backend',
    r.badgeIds.join(',') === 'recommended,top,verified,responsive,delivery,favourite,popular,new');

  const noTab = ctx({ noSnapshotTab: true });
  const r2 = noTab.actionListSellerBadges(ADMIN, {});
  ok('a missing snapshot tab still lists every store, so Recompute can be offered',
    r2.ok && r2.sellers.length === 2 && r2.sellers[0].badges.length === 0);
  ok('and reports them as never worked out rather than as having no badges',
    r2.sellers[0].updatedAt === '' && r2.sellers[0].score === null);
}

/* ---------- overrides ---------- */
{
  let s = ctx();
  let r = s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o1', field: 'verified', value: 'true' });
  ok('an admin can verify a store', r.ok === true, JSON.stringify(r));
  ok('and it is written to the right cell',
    s.tabs.Owners[0].BadgeVerified === 'true', JSON.stringify(s.updated));
  ok('and recomputed immediately - not left for up to six hours', s.recomputes.length === 1);

  s = ctx();
  s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o2', field: 'recommended', value: '' });
  ok('CLEARING an override puts the store back under the automatic rules',
    s.tabs.Owners[1].BadgeRecommended === '', JSON.stringify(s.tabs.Owners[1]));

  s = ctx();
  s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o1', field: 'suppressed', value: 'true' });
  ok('and a store can be hidden from every badge at once',
    s.tabs.Owners[0].BadgeSuppressed === 'true');

  // The request body must never reach a column name.
  s = ctx();
  r = s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o1', field: 'Email', value: 'true' });
  ok('A BODY CANNOT NAME AN ARBITRARY COLUMN - only the three badge controls',
    r.ok === false && s.updated.length === 0, JSON.stringify(r));
  r = s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o1', field: 'PasswordHash', value: 'true' });
  ok('not even a sensitive one', r.ok === false && s.updated.length === 0);

  r = s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'o1', field: 'verified', value: 'maybe' });
  ok('and the value is one of three, not free text', r.ok === false && s.updated.length === 0);

  r = s.actionSetSellerBadgeOverride(ADMIN, { ownerId: 'nope', field: 'verified', value: 'true' });
  ok('a store that does not exist is refused', r.ok === false && /not found/i.test(r.error));
  ok('and none of those refusals recomputed anything', s.recomputes.length === 0);
}

/* ---------- settings ---------- */
{
  let s = ctx();
  let r = s.actionSetBadgeConfig(ADMIN, { key: 'newSellerDays', value: '45' });
  ok('an admin can change a threshold', r.ok === true, JSON.stringify(r));
  ok('and it is stored', s.appended.length === 1 && s.appended[0].obj.Value === '45');
  ok('the config cache is dropped, or the change would not apply for five minutes',
    s.invalidated.indexOf('v1:badgeConfig') !== -1, s.invalidated.join(','));
  ok('and every store is recomputed against it', s.recomputes.length === 1);

  s = ctx({ config: [{ Key: 'newSellerDays', Value: '30' }] });
  s.actionSetBadgeConfig(ADMIN, { key: 'newSellerDays', value: '60' });
  ok('changing it again updates the row rather than adding a second one',
    s.updated.length === 1 && s.appended.length === 0, JSON.stringify([s.updated, s.appended]));

  s = ctx();
  r = s.actionSetBadgeConfig(ADMIN, { key: 'enabled.new', value: 'false' });
  ok('a badge can be switched off site-wide from the admin page', r.ok === true);

  // The whitelist.
  s = ctx();
  r = s.actionSetBadgeConfig(ADMIN, { key: 'somethingInvented', value: '5' });
  ok('A BODY CANNOT INVENT A SETTING - the defaults are the whitelist',
    r.ok === false && /Unknown setting/.test(r.error), JSON.stringify(r));
  ok('and nothing was written', s.appended.length === 0 && s.updated.length === 0);

  r = s.actionSetBadgeConfig(ADMIN, { key: 'newSellerDays', value: 'soon' });
  ok('a threshold that is not a number is refused rather than stored and ignored',
    r.ok === false && /number/.test(r.error), JSON.stringify(r));
  r = s.actionSetBadgeConfig(ADMIN, { key: 'newSellerDays', value: '-5' });
  ok('and a negative one too', r.ok === false);
  r = s.actionSetBadgeConfig(ADMIN, { key: 'enabled.top', value: '1' });
  ok('an on/off setting only takes true or false', r.ok === false && /true or false/.test(r.error));
  ok('none of those wrote anything', s.appended.length === 0 && s.updated.length === 0);

  s = ctx();
  r = s.actionRecomputeBadges(ADMIN);
  ok('an admin can rebuild on demand', r.ok === true && r.sellers === 2, JSON.stringify(r));
}

/* ---------- read from the source ---------- */
{
  ok('all four actions are routed as PROTECTED, so the token is checked first',
    /'listSellerBadges', 'setSellerBadgeOverride', 'setBadgeConfig', 'recomputeBadges'/.test(codeGs));
  // The public list, sliced out rather than matched across the whole file. The
  // first version of this used a greedy [\s\S]* from the declaration, which
  // happily ran past the array and matched the action's name in the PROTECTED
  // list below it - so it "passed" for reasons that had nothing to do with the
  // rule, and failed once the names existed at all.
  const publicList = codeGs.slice(codeGs.indexOf('PUBLIC_POST_ACTIONS = ['),
                                  codeGs.indexOf('];', codeGs.indexOf('PUBLIC_POST_ACTIONS = [')));
  const protectedList = codeGs.slice(codeGs.indexOf('PROTECTED_POST_ACTIONS = ['),
                                     codeGs.indexOf('];', codeGs.indexOf('PROTECTED_POST_ACTIONS = [')));
  ['listSellerBadges', 'setSellerBadgeOverride', 'setBadgeConfig', 'recomputeBadges'].forEach((a) => {
    ok(a + ' is wired into the protected switch', new RegExp("case '" + a + "':").test(codeGs));
    ok(a + ' is in the PROTECTED list', protectedList.indexOf("'" + a + "'") !== -1);
    ok(a + ' is NOT in the PUBLIC list - no token, no answer',
      publicList.indexOf("'" + a + "'") === -1);
  });
  // Proves the slice is real and not matching an empty string.
  ok('the public list really was found and really does hold public actions',
    publicList.indexOf("'createOrder'") !== -1 && publicList.indexOf("'listOwnerOrders'") === -1);
  ok('every one of them checks isOwnerAdmin',
    (admin.match(/if \(!isOwnerAdmin\(owner\)\) return fail\('Not authorized'\);/g) || []).length >= 7);

  const js = fs.readFileSync(REPO + 'assets/js/admin.js', 'utf8');
  ok('the admin page reuses the shared badge component rather than its own markup',
    /renderSellerBadges\(/.test(js) && !/seller-badge--ribbon/.test(js));
  ok('and labels every badge AUTO AWARDED or ADMIN OVERRIDE',
    /ADMIN OVERRIDE/.test(js) && /AUTO AWARDED/.test(js));
  ok('with a third override state, so an override can be undone',
    /opt\('', 'Automatic'\)/.test(js));

  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  ok('the auto/override distinction is lettered, not only coloured',
    /letter-spacing/.test(css.slice(css.indexOf('.badge-admin-source {'),
                                    css.indexOf('.badge-admin-source--auto'))));
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
