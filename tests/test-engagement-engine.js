/**
 * CESN Stage 4-6 - the smart engine (EngagementEngine.gs) and price-drop
 * intelligence (PriceWatch.gs), run against the REAL apps-script sources via
 * the gas-harness. Covers: audience eligibility per category, the 10% price
 * threshold, anti-inflation (dwell), dedupe, retail-only, new arrival, back in
 * stock, frequency caps, and the master/category switches.
 */
const { makeBox } = require('./lib/gas-harness.js');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  [' + JSON.stringify(e) + ']' : '')); } };

const OLD = new Date(Date.now() - 10 * 86400000).toISOString();
const NOW = new Date().toISOString();

function build(seed, props) {
  seed = seed || {};
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status'], ['own_s', 'bong', 'Bong Store', 'active']],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'ImageUrl', 'Status']].concat(seed.Products || [['p1', 'own_s', 'bong', 'Rice', '', 'active']]),
    Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status']].concat(seed.Variants || [['v1', 'p1', 'own_s', '10kg', 20, '', 50, 'active']]),
    ProductWatch: [['WatchId', 'ProductId', 'VariantId', 'StoreSlug', 'PriceType', 'LastPrice', 'PriceSince', 'LastStock', 'LastNotifiedPrice', 'FirstSeenAt', 'UpdatedAt']].concat(seed.ProductWatch || []),
    StoreFollows: [['FollowId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreFollows || [
      ['f1', 'cus_f', 'bong', 'active', 'true', OLD, OLD],
      ['f2', 'cus_x', 'bong', 'active', 'false', OLD, OLD]   // notifications OFF -> excluded
    ]),
    StoreLikes: [['LikeId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreLikes || [
      ['l1', 'cus_l', 'bong', 'active', 'true', OLD, OLD]
    ]),
    StoreMarketingConsents: [['ConsentId', 'CustomerId', 'StoreSlug', 'Status', 'OptInAt', 'WithdrawnAt', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreMarketingConsents || [
      ['c1', 'cus_s', 'bong', 'active', OLD, '', OLD, OLD]
    ]),
    Notifications: [['NotificationId', 'CustomerId', 'StoreSlug', 'Category', 'Title', 'Body', 'ImageUrl', 'DeepLink', 'CampaignId', 'SourceKey', 'ReadAt', 'CreatedAt']].concat(seed.Notifications || []),
    CesnAudit: [['EventId', 'StoreSlug', 'Category', 'SourceKey', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'CreatedAt']],
    PushSubscriptions: [['SubId', 'CustomerId', 'FcmToken', 'UserAgent', 'Platform', 'Status', 'LastSeenAt', 'CreatedAt']]
  }, { guest: true });
  Object.keys(props || {}).forEach((k) => { box.__props[k] = props[k]; });
  return box;
}
const notifs = (box) => box.__sheets.Notifications.objects();
const notifsFor = (box, cat) => notifs(box).filter((r) => r.Category === cat);

/* ---- price drop: threshold, audience, dedupe ---- */
{
  const box = build({ ProductWatch: [['w1', 'p1', 'v1', 'bong', 'retail', 25, OLD, 50, '', OLD, OLD]] });
  const r = box.runEngagementSweep();
  const drops = notifsFor(box, 'price_drop');
  const who = drops.map((n) => n.CustomerId).sort().join(',');
  t('price drop (25->20 = 20%) fires to engaged audience only', drops.length === 2 && who === 'cus_f,cus_l', { who, n: drops.length });
  t('price drop excludes notify-off follower and subscriber-only + stranger',
    who.indexOf('cus_x') === -1 && who.indexOf('cus_s') === -1 && who.indexOf('cus_n') === -1);
  t('price drop wrote an audit row with queued=2', box.__sheets.CesnAudit.objects().some((a) => a.Category === 'price_drop' && Number(a.Queued) === 2));
  const r2 = box.runEngagementSweep();   // same price again
  t('price drop is not repeated on the next sweep (dedupe)', notifsFor(box, 'price_drop').length === 2, { after: notifsFor(box, 'price_drop').length });
}

/* ---- 9.9% vs 10% boundary ---- */
{
  const a = build({ Variants: [['v1', 'p1', 'own_s', '10kg', 90.1, '', 50, 'active']], ProductWatch: [['w1', 'p1', 'v1', 'bong', 'retail', 100, OLD, 50, '', OLD, OLD]] });
  a.runEngagementSweep();
  t('9.9% drop does NOT trigger', notifsFor(a, 'price_drop').length === 0);
  const b = build({ Variants: [['v1', 'p1', 'own_s', '10kg', 90, '', 50, 'active']], ProductWatch: [['w1', 'p1', 'v1', 'bong', 'retail', 100, OLD, 50, '', OLD, OLD]] });
  b.runEngagementSweep();
  t('exactly 10% drop DOES trigger', notifsFor(b, 'price_drop').length === 2);
}

/* ---- anti-inflation: a price that only just changed cannot trigger a drop ---- */
{
  const box = build({ ProductWatch: [['w1', 'p1', 'v1', 'bong', 'retail', 25, NOW, 50, '', NOW, NOW]] });  // PriceSince = now
  box.runEngagementSweep();
  t('a drop off a price that has not dwelled long enough is suppressed (anti-inflation)', notifsFor(box, 'price_drop').length === 0);
}

/* ---- retail-only: no retail price change -> no drop (wholesale is separate) ---- */
{
  const box = build({ ProductWatch: [['w1', 'p1', 'v1', 'bong', 'retail', 20, OLD, 50, '', OLD, OLD]] });  // price unchanged at 20
  box.runEngagementSweep();
  t('no retail price change -> no price-drop notification', notifsFor(box, 'price_drop').length === 0);
}

/* ---- new arrival + back in stock ---- */
{
  // No ProductWatch rows: p1 is brand new. Stock starts at 0. Min-interval set
  // to 0 here so the two sweeps (seconds apart in the test) both emit - the
  // interval rule itself is covered by the frequency-cap case below.
  const box = build({ Variants: [['v1', 'p1', 'own_s', '10kg', 20, '', 0, 'active']], ProductWatch: [] }, { CESN_MIN_INTERVAL_MIN: '0' });
  box.runEngagementSweep();
  t('new arrival fires for a brand-new product', notifsFor(box, 'new_arrival').length === 2);
  t('first sweep does NOT fire back-in-stock (no prior state)', notifsFor(box, 'back_in_stock').length === 0);
  // Now it comes into stock.
  box.__sheets.Variants.grid[1][6] = 50;   // StockQty -> 50
  box.runEngagementSweep();
  t('back in stock fires when stock goes 0 -> positive', notifsFor(box, 'back_in_stock').length === 2);
  t('new arrival is not repeated for a now-known product', notifsFor(box, 'new_arrival').length === 2);
}

/* ---- frequency cap ---- */
{
  const box = build(
    { Notifications: [['n0', 'cus_f', 'bong', 'price_drop', 'x', 'y', '', '', '', 'old', '', NOW]] },   // cus_f already got 1 today
    { CESN_MAX_PER_DAY: '1' }
  );
  const r = box.emitEngagementEvent({ storeSlug: 'bong', category: 'new_arrival', title: 'T', body: 'B', sourceKey: 'freqtest' });
  const got = notifs(box).filter((n) => n.SourceKey === 'freqtest').map((n) => n.CustomerId);
  t('frequency cap: cus_f (already at the daily cap) is skipped, cus_l still gets it', got.indexOf('cus_f') === -1 && got.indexOf('cus_l') !== -1 && r.skippedFreq === 1, { got, r });
}

/* ---- audience policies ---- */
{
  const box = build();
  box.emitEngagementEvent({ storeSlug: 'bong', category: 'flash_sale', title: 'Flash', body: 'B', sourceKey: 'fs1' });
  const fs = notifs(box).filter((n) => n.SourceKey === 'fs1').map((n) => n.CustomerId);
  t('flash_sale (subscribers) -> only the marketing subscriber', fs.join(',') === 'cus_s', fs);
  box.emitEngagementEvent({ storeSlug: 'bong', category: 'exclusive_discount', title: 'VIP', body: 'B', sourceKey: 'ex1' });
  const ex = notifs(box).filter((n) => n.SourceKey === 'ex1').map((n) => n.CustomerId);
  t('exclusive_discount (followers) -> only the follower, not the liker or subscriber', ex.join(',') === 'cus_f', ex);
}

/* ---- master + category switches ---- */
{
  const off = build(null, { CESN_ENABLED: 'false' });
  const r1 = off.emitEngagementEvent({ storeSlug: 'bong', category: 'new_arrival', sourceKey: 's', title: 'T' });
  t('master switch off -> nothing queued', r1.reason === 'disabled' && r1.queued === 0 && notifs(off).length === 0);
  const catoff = build(null, { CESN_CATEGORIES_OFF: 'price_drop' });
  const r2 = catoff.emitEngagementEvent({ storeSlug: 'bong', category: 'price_drop', sourceKey: 's', title: 'T' });
  t('a disabled category -> nothing queued', r2.reason === 'category-off' && r2.queued === 0);
  const r3 = catoff.emitEngagementEvent({ storeSlug: 'bong', category: 'new_arrival', sourceKey: 's2', title: 'T' });
  t('other categories still work when one is disabled', r3.queued === 2);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
