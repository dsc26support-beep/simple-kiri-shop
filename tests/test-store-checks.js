/**
 * Owner decision, Oct 2026 - store checks. On the REAL backend (gas-harness):
 *  - every store starts "not yet checked" and is ranked last;
 *  - the owner ticks Call, Email and Visit; only then can they give New,
 *    which ranks the store above unchecked ones;
 *  - a New store becomes Verified at 4.5 stars over 10+ reviews, or the owner
 *    gives Verified by hand; Verified replaces New and ranks first;
 *  - removing New or Verified needs a reason; a removed Verified does not come
 *    back from ratings until the owner lets ratings decide again;
 *  - only an admin can do any of it, and every change is logged (TrustLog).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const oHead = ['OwnerId', 'StoreName', 'StoreSlug', 'Email', 'Phone', 'Status', 'Island', 'Village', 'CreatedAt', 'Visits', 'DeliveryPickPay'];
const box = makeBox({
  Owners: [oHead,
    ['adm', 'Mwakete Admin', 'mwakete-admin', 'boss@mwakete.com', '', 'active', 'South Tarawa', 'Bairiki', '2026-01-01', 0, 'true'],
    ['o_a', 'Aroita Shop', 'aroita', 'a@x.test', '73000001', 'active', 'South Tarawa', 'Betio', '2026-10-01', 500, 'true'],
    ['o_b', 'Bwebwe Store', 'bwebwe', 'b@x.test', '73000002', 'active', 'South Tarawa', 'Bikenibeu', '2026-10-02', 100, 'true'],
    ['o_c', 'Coco Mart', 'coco', 'c@x.test', '73000003', 'active', 'South Tarawa', 'Teaoraereke', '2026-10-03', 10, 'true']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'Views'],
    ['p_a', 'o_a', 'aroita', 'Bucket A', 'Blue bucket', 'home', 'product', 'active', 900],
    ['p_b', 'o_b', 'bwebwe', 'Bucket B', 'Red bucket', 'home', 'product', 'active', 50],
    ['p_c', 'o_c', 'coco', 'Bucket C', 'Green bucket', 'home', 'product', 'active', 5]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'],
    ['v_a', 'p_a', 'o_a', 'One', 5, 9, 'active'], ['v_b', 'p_b', 'o_b', 'One', 5, 9, 'active'], ['v_c', 'p_c', 'o_c', 'One', 5, 9, 'active']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'CustomerId', 'CustomerName', 'Rating', 'Comment', 'Status', 'CreatedAt']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerEmail', 'Status', 'CreatedAt', 'Total']],
  Conversations: [['ConversationId', 'OwnerId']], Messages: [['MessageId', 'ConversationId', 'SenderType', 'CreatedAt']],
  SellerBadges: [['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt']],
  BadgeConfig: [['Key', 'Value', 'UpdatedAt']], Featured: [['Type', 'RefId', 'SortOrder']], Bookings: [['BookingId', 'OwnerId', 'Status']]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const row = (id) => Object.assign({ __row: box.__sheets.Owners.objects().findIndex((o) => o.OwnerId === id) + 2 }, box.__sheets.Owners.objects().find((o) => o.OwnerId === id));
const ADMIN = () => row('adm');
const set = (id, op, extra) => { clear(); return box.actionSetStoreTrust(ADMIN(), Object.assign({ ownerId: id, op }, extra || {})); };
const order = () => { clear(); return {
  stores: box.actionListStores({}).stores.filter((s) => s.storeSlug !== 'mwakete-admin').map((s) => s.storeSlug),
  top: box.actionListTopStores().stores.filter((s) => s.storeSlug !== 'mwakete-admin').map((s) => s.storeSlug),
  products: box.actionListTopProducts().products.map((p) => p.productId),
  search: box.actionSearchProducts({ q: 'bucket' }).products.map((p) => p.productId),
  badges: Object.fromEntries(box.actionListTopStores().stores.map((s) => [s.storeSlug, (s.sellerBadges || []).join(',')]))
}; };

/* ---------- everyone starts not yet checked ---------- */
box.recomputeSellerBadges();
let o = order();
ok('every store starts "not yet checked"', ['aroita', 'bwebwe', 'coco'].every((s) => o.badges[s] === 'unchecked'), J(o.badges));
ok('...and with nobody checked, the usual order stands (most visited first)', o.top.join(',') === 'aroita,bwebwe,coco', o.top.join(','));

/* ---------- only an admin ---------- */
let r = box.actionSetStoreTrust(row('o_c'), { ownerId: 'o_c', op: 'check', check: 'call' });
ok('a seller cannot tick their own checks', !r.ok && /Not authorized/.test(r.error), J(r));
ok('...nor list them', !box.actionListStoreTrust(row('o_c')).ok);

/* ---------- New needs all three checks ---------- */
r = set('o_c', 'giveNew');
ok('New is refused before any check', !r.ok && /call, email, visit/.test(r.error), J(r));
set('o_c', 'check', { check: 'call' }); set('o_c', 'check', { check: 'email' });
r = set('o_c', 'giveNew');
ok('...and with only call and email', !r.ok && /visit/.test(r.error), J(r));
r = set('o_c', 'check', { check: 'teleport' });
ok('an unknown check is refused', !r.ok, J(r));
set('o_c', 'check', { check: 'visit' });
const c = row('o_c');
ok('each tick records when and who', /\|boss@mwakete\.com$/.test(c.CheckCall) && /\|boss@mwakete\.com$/.test(c.CheckVisit), c.CheckCall);
r = set('o_c', 'giveNew');
ok('with all three ticked, New is given', r.ok && row('o_c').BadgeNew === 'true', J(r));

o = order();
ok('the New store now shows New, not "not yet checked"', o.badges.coco === 'new', J(o.badges));
ok('NEW RANKS ABOVE NOT YET CHECKED - store directory', o.stores[0] === 'coco', o.stores.join(','));
ok('...Top Stores (despite the fewest visits)', o.top.join(',') === 'coco,aroita,bwebwe', o.top.join(','));
ok('...Top Products (despite the fewest views)', o.products[0] === 'p_c', o.products.join(','));
ok('...and search', o.search[0] === 'p_c', o.search.join(','));

/* ---------- Verified ---------- */
r = set('o_b', 'giveVerified');
o = order();
ok('the owner can give Verified to any store', r.ok && o.badges.bwebwe === 'verified', J(o.badges));
ok('VERIFIED RANKS FIRST, then New, then not yet checked', o.top.join(',') === 'bwebwe,coco,aroita' && o.search.join(',') === 'p_b,p_c,p_a', J([o.top, o.search]));

// Ratings: a New store at 4.5 over 10 reviews becomes Verified on its own.
const rv = box.__sheets.Reviews.grid;
for (let i = 0; i < 10; i++) rv.push(['r' + i, 'p_c', 'o_c', 'cus' + i, 'C' + i, i < 5 ? 5 : 4, '', 'published', '2026-10-10']);
box.recomputeSellerBadges();
o = order();
ok('A NEW STORE AT 4.5 STARS OVER 10 REVIEWS BECOMES VERIFIED, replacing New', o.badges.coco === 'verified', J(o.badges));
for (let i = 0; i < 10; i++) rv.push(['s' + i, 'p_a', 'o_a', 'cus' + i, 'C' + i, 5, '', 'published', '2026-10-10']);
box.recomputeSellerBadges();
ok('...but ratings never verify a store nobody checked', order().badges.aroita === 'unchecked');

/* ---------- removing needs a reason ---------- */
r = set('o_c', 'removeVerified', { reason: '' });
ok('removing Verified without a reason is refused', !r.ok && /reason/i.test(r.error), J(r));
r = set('o_c', 'removeVerified', { reason: 'Customer complaints about fake stock' });
o = order();
ok('with a reason it is removed, and the store falls back to New', r.ok && o.badges.coco === 'new', J(o.badges));
box.recomputeSellerBadges();
ok('A REMOVED VERIFIED DOES NOT COME BACK FROM RATINGS', order().badges.coco === 'new');
set('o_c', 'ratingsDecide');
ok('...until the owner lets ratings decide again', order().badges.coco === 'verified');
r = set('o_c', 'removeNew', { reason: 'no' });
ok('a too-short reason is refused', !r.ok, J(r));

/* ---------- the log ---------- */
const log = box.__sheets.TrustLog ? box.__sheets.TrustLog.objects() : [];
ok('every change is logged with who did it (refused attempts are not)', log.length === 7 && log.every((l) => l.By === 'boss@mwakete.com'), J(log.length));
ok('...including the removal reason', log.some((l) => l.Action === 'removeVerified' && /fake stock/.test(l.Detail)));

/* ---------- the admin list ---------- */
const list = box.actionListStoreTrust(ADMIN());
ok('the admin list puts not-yet-checked stores first', list.ok && list.stores[0].trust === 'unchecked', J(list.stores && list.stores.map((s) => s.storeSlug + ':' + s.trust)));
const cRow = list.stores.find((s) => s.ownerId === 'o_c');
ok('...with each store\'s checks, rating and Verified setting', cRow.checks.call && cRow.checks.email && cRow.checks.visit && cRow.reviews === 10 && cRow.verifiedSetting === '', J(cRow));

/* ---------- the seller's own dashboard ---------- */
const dash = box.actionGetSellerDashboard(row('o_a'), {});
ok('a seller sees they are not yet checked, and which checks are done', dash.ok && dash.storeCheck.status === 'unchecked'
  && dash.storeCheck.call === false && dash.storeCheck.visit === false, J(dash.storeCheck));
ok('...never who ticked them', JSON.stringify(dash.storeCheck).indexOf('boss@') === -1);
ok('a checked store sees where it stands', box.actionGetSellerDashboard(row('o_c'), {}).storeCheck.status === 'verified');

let fails = 0;
console.log('\n--- store checks: New & Verified (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
