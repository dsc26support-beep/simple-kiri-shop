/**
 * Store search, run against the REAL actionListStores from Products.gs.
 *
 * The backend already searched stores before this suite existed; what it did
 * not do was forgive a double space, cap the length of the text it was handed,
 * or put the best answer first. Those three are the changes under test, and
 * the rest of this file exists to prove the things that already worked still
 * work - the store directory, the pagination, the exclusion of closed stores
 * and the response shape are all served by this same function.
 *
 * Nothing here mocks the function itself. getSheet and sheetToObjects are
 * stubbed to hand over a fixed set of Owners rows, getCached is a real
 * key/value cache so the caching claims can be checked, and everything else
 * is the source as deployed.
 */
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const productsSrc = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const utilsSrc = fs.readFileSync(REPO + 'apps-script/Utils.gs', 'utf8');
const authSrc = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');

const grab = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n}'));
  if (!m) throw new Error('could not find ' + name + ' in source');
  return m[0];
};
const grabVar = (src, name) => {
  const m = src.match(new RegExp('^var ' + name + ' = .*?;$', 'm'));
  if (!m) throw new Error('could not find var ' + name + ' in source');
  return m[0];
};

/* ---------- the rows the fake Owners sheet hands back ---------------------- */
// Status 'active' and 'standby' are browsable; anything else is not. Village
// and island are here because they have always been searchable.
const OWNERS = [
  { OwnerId: 'o1', StoreSlug: 'zebra-store',  StoreName: 'Zebra Store',        Phone: '+68673000001', Island: 'South Tarawa', Village: 'Bairiki',  LogoUrl: 'z.png', Status: 'active', Email: 'z@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o2', StoreSlug: 'betio',        StoreName: 'Betio',              Phone: '+68673000002', Island: 'South Tarawa', Village: 'Betio',    LogoUrl: 'b.png', Status: 'active', Email: 'b@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o3', StoreSlug: 'betio-hire',   StoreName: 'Betio Hire',         Phone: '+68673000003', Island: 'South Tarawa', Village: 'Bikenibeu', LogoUrl: 'bh.png', Status: 'active', Email: 'bh@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o4', StoreSlug: 'hire-betio',   StoreName: 'Hire A Betio Van',   Phone: '+68673000004', Island: 'Abaiang',      Village: 'Taburao',  LogoUrl: 'hb.png', Status: 'active', Email: 'hb@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o5', StoreSlug: 'corner-shop',  StoreName: 'Corner Shop',        Phone: '+68673000005', Island: 'South Tarawa', Village: 'Betio',    LogoUrl: 'c.png', Status: 'active', Email: 'c@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o6', StoreSlug: 'abc-store',    StoreName: 'Abc Store',          Phone: '+68673000006', Island: 'Kiritimati',   Village: 'London',   LogoUrl: 'a.png', Status: 'active', Email: 'a@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o7', StoreSlug: 'big-onion',    StoreName: 'Big Elephant Tiny Onion', Phone: '+68673000007', Island: 'Teraina', Village: 'Tabwakea', LogoUrl: 'o.png', Status: 'active', Email: 'o@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o8', StoreSlug: 'resting',      StoreName: 'Resting Store',      Phone: '+68673000008', Island: 'Tabuaeran',    Village: 'Napari',   LogoUrl: 'r.png', Status: 'standby', Email: 'r@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o9', StoreSlug: 'gone-store',   StoreName: 'Gone Store',         Phone: '+68673000009', Island: 'Makin',        Village: 'Makin',    LogoUrl: 'g.png', Status: 'suspended', Email: 'g@example.com', PasswordHash: 'nope' },
  { OwnerId: 'o10', StoreSlug: 'long-name',   StoreName: 'a'.repeat(200) + ' Shop', Phone: '+68673000010', Island: 'Banaba',  Village: 'Antereen', LogoUrl: 'l.png', Status: 'active', Email: 'l@example.com', PasswordHash: 'nope' }
];

/* ---------- build a context holding the real code -------------------------- */
let sheetReads = 0;
function makeContext() {
  const cache = new Map();
  sheetReads = 0;
  const box = {
    // stubs standing in for the spreadsheet and the plumbing around it
    getSheet: function (name) { return { name: name }; },
    sheetToObjects: function (sheet) {
      if (sheet.name !== 'Owners') throw new Error('unexpected sheet ' + sheet.name);
      sheetReads++;
      return OWNERS.map(function (o) { return Object.assign({}, o); });
    },
    sellerBadgeIndex: function () { return {}; },
    attachSellerBadges: function (obj) { return obj; },
    deliveryFlagsOf: function () { return { deliversLocal: true, deliversShip: false, deliversAir: false }; },
    getCached: function (key, ttl, producer) {
      if (cache.has(key)) return cache.get(key);
      const value = producer();
      cache.set(key, value);
      return value;
    },
    ok: function (data) { return Object.assign({ ok: true }, data); },
    Object: Object, Math: Math, String: String, Number: Number, JSON: JSON
  };
  vm.createContext(box);
  vm.runInContext([
    grab(authSrc, 'isStoreBrowsable'),
    grab(utilsSrc, 'clampPageSize'),
    grabVar(utilsSrc, 'DEFAULT_LIST_PAGE_SIZE'),
    grabVar(utilsSrc, 'MAX_LIST_PAGE_SIZE'),
    grab(productsSrc, 'storeListCacheKey'),
    grabVar(productsSrc, 'STORE_SEARCH_MAX_QUERY'),
    grab(productsSrc, 'normalizeStoreSearchText'),
    grab(productsSrc, 'storeSearchScore'),
    grab(productsSrc, 'actionListStores')
  ].join('\n\n'), box);
  box.__cache = cache;
  return box;
}

const ctx = makeContext();
const list = (params) => ctx.actionListStores(params);
const names = (res) => res.stores.map(function (s) { return s.storeName; });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 1. the matching matrix ----------------------------------------- */
{
  ok('exact name finds the store', names(list({ q: 'Abc Store' })).indexOf('Abc Store') === 0,
    JSON.stringify(names(list({ q: 'Abc Store' }))));
  ok('partial name finds the store', names(list({ q: 'Abc' })).indexOf('Abc Store') !== -1);
  ok('a fragment from the middle finds the store', names(list({ q: 'lephant' })).indexOf('Big Elephant Tiny Onion') !== -1);
  ok('all lowercase finds the store', names(list({ q: 'abc store' })).indexOf('Abc Store') === 0);
  ok('all uppercase finds the store', names(list({ q: 'ABC STORE' })).indexOf('Abc Store') === 0);
  ok('mixed case finds the store', names(list({ q: 'aBc StOrE' })).indexOf('Abc Store') === 0);
  ok('leading spaces are ignored', names(list({ q: '   Abc Store' })).indexOf('Abc Store') === 0);
  ok('trailing spaces are ignored', names(list({ q: 'Abc Store   ' })).indexOf('Abc Store') === 0);
  ok('spaces on both sides are ignored', names(list({ q: '  Abc Store  ' })).indexOf('Abc Store') === 0);

  // The defect this task was opened for.
  const dbl = names(list({ q: 'Abc  Store' }));
  ok('an internal DOUBLE space still finds the store', dbl.indexOf('Abc Store') === 0, JSON.stringify(dbl));
  ok('three internal spaces still find the store', names(list({ q: 'Abc   Store' })).indexOf('Abc Store') === 0);
  ok('a tab between the words still finds the store', names(list({ q: 'Abc\tStore' })).indexOf('Abc Store') === 0);
  ok('a newline between the words still finds the store', names(list({ q: 'Abc\nStore' })).indexOf('Abc Store') === 0);

  ok('several words in the wrong order still find the store',
    names(list({ q: 'onion elephant' })).indexOf('Big Elephant Tiny Onion') !== -1);
  ok('an island name finds stores on that island', names(list({ q: 'Kiritimati' })).indexOf('Abc Store') !== -1);
  ok('a village name finds stores in that village', names(list({ q: 'Bairiki' })).indexOf('Zebra Store') !== -1);

  const none = list({ q: 'qqqzzz no such store' });
  ok('a query that matches nothing returns an empty list', none.stores.length === 0);
  ok('and reports a total of zero', none.total === 0);
  ok('and reports no further pages', none.hasMore === false);

  const many = list({ q: 'store' });
  ok('a query matching several stores returns all of them',
    eq(names(many).slice().sort(), ['Abc Store', 'Resting Store', 'Zebra Store']), JSON.stringify(names(many)));
  ok('and total counts the matches, not the whole directory',
    many.total === many.stores.length && many.total < OWNERS.length, 'total=' + many.total);
}

/* ---------- 2. ranking ------------------------------------------------------ */
{
  const r = names(list({ q: 'betio' }));
  // Betio (exact) -> Betio Hire (starts with) -> Hire A Betio Van (contains)
  // -> Corner Shop (matches only on its village).
  ok('the exact name is first', r[0] === 'Betio', JSON.stringify(r));
  ok('a name STARTING with the query is second', r[1] === 'Betio Hire', JSON.stringify(r));
  ok('a name merely containing the query comes after those', r.indexOf('Hire A Betio Van') === 2, JSON.stringify(r));
  ok('a match on the place alone comes last', r[r.length - 1] === 'Corner Shop', JSON.stringify(r));
  ok('every store mentioning betio is still returned', r.length === 4, JSON.stringify(r));

  // Nothing that matched before may stop matching. The old search joined
  // name, island and village into one string, so a query crossing that join
  // was a match; it still is, ranked below everything else.
  const join = names(list({ q: 'shop south' }));
  ok('a query spanning name and island still matches, as it did before',
    join.indexOf('Corner Shop') !== -1, JSON.stringify(join));
  const mixed = names(list({ q: 'betio' }));
  ok('and that weakest match never outranks a real name match',
    mixed[0] === 'Betio', JSON.stringify(mixed));

  const w = names(list({ q: 'big onion' }));
  ok('all query words present in a name is a match', w.indexOf('Big Elephant Tiny Onion') === 0, JSON.stringify(w));
  ok('a single word that is not in the name is not a match',
    names(list({ q: 'onionx' })).length === 0);

  // Two identical requests must not come back in two different orders.
  const a = names(list({ q: 'store' }));
  const b = names(list({ q: 'store' }));
  ok('the same query twice gives the same order', eq(a, b), JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  // All three of these merely contain the word, so they sit in one score
  // band and the only thing separating them is the alphabet.
  ok('stores of equal relevance are ordered alphabetically',
    eq(a.slice().sort(), a), JSON.stringify(a));
}

/* ---------- 3. the length cap ---------------------------------------------- */
{
  ok('the cap is declared at 200 characters', ctx.STORE_SEARCH_MAX_QUERY === 200,
    String(ctx.STORE_SEARCH_MAX_QUERY));

  const long = 'z'.repeat(5000);
  let threw = null;
  let res = null;
  const started = Date.now();
  try { res = list({ q: long }); } catch (err) { threw = err; }
  const took = Date.now() - started;
  ok('a 5000-character query does not throw', !threw, threw && threw.message);
  ok('a 5000-character query returns no matches', res && res.stores.length === 0);
  ok('and is answered promptly', took < 250, took + 'ms');

  // Proof the query really is cut at 200: the store's name is 200 'a's plus
  // " Shop", and a query of 250 'a's - which the full name does NOT begin
  // with beyond 200 - still matches on the truncated prefix.
  const truncated = names(list({ q: 'a'.repeat(250) }));
  ok('a query longer than the cap is truncated rather than rejected',
    truncated.length === 1, JSON.stringify(truncated.length));

  ok('normalizeStoreSearchText handles null without throwing', ctx.normalizeStoreSearchText(null) === '');
  ok('normalizeStoreSearchText handles undefined without throwing', ctx.normalizeStoreSearchText(undefined) === '');
  let numThrew = null;
  try { list({ q: 12345 }); } catch (err) { numThrew = err; }
  ok('a numeric q does not throw', !numThrew, numThrew && numThrew.message);
  let objThrew = null;
  try { list({ q: { evil: true } }); } catch (err) { objThrew = err; }
  ok('an object q does not throw', !objThrew, objThrew && objThrew.message);
  let reThrew = null;
  let reRes = null;
  try { reRes = list({ q: '.*(' }); } catch (err) { reThrew = err; }
  ok('a query of regex metacharacters does not throw', !reThrew, reThrew && reThrew.message);
  ok('and is treated as plain text, matching nothing', reRes && reRes.stores.length === 0);
}

/* ---------- 4. what must NOT have changed ---------------------------------- */
{
  const all = list({});
  ok('an empty query returns the whole browsable directory', all.total === 9, 'total=' + all.total);
  ok('and keeps the order the sheet gave it',
    eq(names(all).slice(0, 3), ['Zebra Store', 'Betio', 'Betio Hire']), JSON.stringify(names(all)));
  ok('a whitespace-only query is treated as no query at all', list({ q: '   ' }).total === all.total);

  ok('a suspended store is never returned', names(all).indexOf('Gone Store') === -1);
  ok('a suspended store is not findable by name either', list({ q: 'Gone Store' }).stores.length === 0);
  ok('a standby store IS returned', names(all).indexOf('Resting Store') !== -1);
  ok('a standby store is findable by name', names(list({ q: 'Resting' })).indexOf('Resting Store') === 0);

  const shape = all.stores[0];
  ok('the response shape is still { stores, total, hasMore }',
    Array.isArray(all.stores) && typeof all.total === 'number' && typeof all.hasMore === 'boolean');
  ok('and it still reports ok', all.ok === true);
  ok('a store still carries exactly the public fields it always did',
    eq(Object.keys(shape).sort(),
      ['deliversAir', 'deliversLocal', 'deliversShip', 'island', 'logoUrl', 'phone', 'storeName', 'storeSlug', 'village']),
    JSON.stringify(Object.keys(shape).sort()));
}

/* ---------- 4b. the strict-superset guarantee ------------------------------
 *
 * The old search was: lowercase the query, lowercase name + island + village
 * joined by spaces, and ask whether one contains the other. Every query that
 * found a store that way must still find it. Rather than argue about it, this
 * replays hundreds of such queries - real substrings taken from every store's
 * own text - and requires each one to still return its store.
 */
{
  const misses = [];
  let checked = 0;
  OWNERS.filter(function (o) { return o.Status === 'active' || o.Status === 'standby'; })
    .forEach(function (o) {
      const hay = (o.StoreName + ' ' + o.Island + ' ' + o.Village).toLowerCase();
      for (let start = 0; start < hay.length; start += 3) {
        for (const len of [3, 7, 12, 25]) {
          const q = hay.slice(start, start + len);
          if (q.trim().length < 3) continue;
          checked++;
          if (names(list({ q: q })).indexOf(o.StoreName) === -1) misses.push(q);
        }
      }
    });
  ok('every substring search that worked before still finds its store',
    misses.length === 0, misses.slice(0, 5).map(JSON.stringify).join(', '));
  ok('and that was checked against a real number of queries', checked > 200, 'checked=' + checked);
}

/* ---------- 5. nothing private leaks --------------------------------------- */
{
  const serialised = JSON.stringify(list({ q: 'store' })) + JSON.stringify(list({}));
  [['Email', 'example.com'], ['password hash', 'nope'], ['owner id', '"o1"'], ['sheet status', 'suspended']]
    .forEach(function (pair) {
      ok('no ' + pair[0] + ' appears in a search response', serialised.indexOf(pair[1]) === -1);
    });
}

/* ---------- 6. paging and caching ------------------------------------------ */
{
  const fresh = makeContext();
  const readsAtStart = sheetReads;
  fresh.actionListStores({ q: 'betio' });
  fresh.actionListStores({ q: 'abc' });
  fresh.actionListStores({ q: 'store' });
  fresh.actionListStores({});
  ok('four different queries cost ONE sheet read, not four', sheetReads - readsAtStart === 1,
    'reads=' + (sheetReads - readsAtStart));
  ok('the cache key does not contain the query',
    Array.from(fresh.__cache.keys()).join(',') === 'v2:listStores',
    Array.from(fresh.__cache.keys()).join(','));

  const p1 = list({ q: 'betio', limit: 2 });
  ok('limit is honoured alongside a query', p1.stores.length === 2);
  ok('total still counts every match, not just this page', p1.total === 4, 'total=' + p1.total);
  ok('hasMore is true when matches remain', p1.hasMore === true);
  const p2 = list({ q: 'betio', limit: 2, offset: 2 });
  ok('offset continues the same ranked list', names(p2)[0] === 'Hire A Betio Van', JSON.stringify(names(p2)));
  ok('hasMore is false on the last page', p2.hasMore === false);
  ok('paging never repeats a store', names(p1).concat(names(p2)).length === new Set(names(p1).concat(names(p2))).size);
  ok('an absurd limit is clamped, not obeyed', list({ q: 'store', limit: 100000 }).stores.length <= 100);
  ok('a negative offset is treated as the start', names(list({ q: 'betio', offset: -5 }))[0] === 'Betio');
}

/* ---------- report ---------------------------------------------------------- */
const failed = R.filter(function (r) { return r[0] === 'FAIL'; });
R.forEach(function (r) { console.log(r[0] + '  ' + r[1] + (r[2] ? '   -> ' + r[2] : '')); });
console.log('\n' + (R.length - failed.length) + '/' + R.length + (failed.length ? '  ** ' + failed.length + ' FAILED **' : '  ALL PASS'));
process.exit(failed.length ? 1 : 0);
