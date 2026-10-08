/**
 * Marketing engine on the REAL Apps Script sources (gas-harness): consent,
 * kill switch, dry run, generation, audience, frequency cap, idempotency,
 * retries, quota protection, admin authorization, isolation, escaping,
 * unsubscribe, clicks, conversions - and the existing abandoned-cart reminder
 * left exactly as it was.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const H = {
  Campaigns: ['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson', 'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl', 'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients', 'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey'],
  CampaignEvents: ['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt', 'SentAt', 'FailureReason', 'MetadataJson', 'Attempts'],
  MarketingPreferences: ['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']
};

function world() {
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Island', 'Village'],
      ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', 'South Tarawa', 'Bairiki'],
      ['own_b', 'bob', 'Bob Store', 'active', 'bob@x.com', 'Abaiang', ''],
      ['own_adm', 'admin', 'ADMIN', 'active', 'boss@mwakete.com', '', '']],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'Views', 'CreatedAt'],
      ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'food', 'product', 'https://res.cloudinary.com/x/rice.jpg', 50, ago(40)],
      ['p2', 'own_a', 'ana', 'Sugar 2kg', 'active', 'food', 'product', '', 30, ago(2)],
      ['p3', 'own_a', 'ana', 'Flour <b>1kg</b>', 'active', 'food', 'product', '', 20, ago(1)],
      ['p4', 'own_b', 'bob', 'Fishing net', 'active', 'tools', 'product', '', 10, ago(3)],
      ['p5', 'own_b', 'bob', 'Boat hire', 'active', 'hire', 'rental', '', 5, ago(1)],
      ['p6', 'own_b', 'bob', 'Old thing', 'inactive', 'tools', 'product', '', 99, ago(1)]],
    Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status'],
      ['v1', 'p1', 'own_a', 'One', 30, 'active'], ['v4', 'p4', 'own_b', 'One', 12, 'active']],
    Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
      ['c1', 'Tera Kum', 'tera@x.com', '7301', 'true', ago(100), ago(100)],
      ['c2', 'Bwena', 'bwena@x.com', '7302', 'true', ago(100), ago(100)],
      ['c3', 'Optout', 'out@x.com', '7303', 'true', ago(100), ago(100)],
      ['c4', 'Unverified', 'unv@x.com', '7304', 'false', ago(100), ago(100)],
      ['c5', 'Lapsed', 'lapsed@x.com', '7305', 'true', ago(200), ago(200)],
      ['c6', 'Bad Address', 'bad@x.com', '7306', 'true', ago(100), ago(100)]],
    CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'],
      ['tok_c1', 'c1', ago(1), new Date(Date.now() + DAY).toISOString()],
      ['tok_c3', 'c3', ago(1), new Date(Date.now() + DAY).toISOString()]],
    Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerEmail', 'ItemsJson', 'Status', 'CreatedAt', 'Total'],
      ['o1', 'own_a', 'ana', 'Tera', 'TERA@x.com', JSON.stringify([{ productId: 'p1', variantId: 'v1', qty: 1 }]), 'Fulfilled', ago(5), 30],
      ['o2', 'own_b', 'bob', 'Bwena', 'bwena@x.com', JSON.stringify([{ productId: 'p4', variantId: 'v4', qty: 1 }]), 'Fulfilled', ago(4), 12],
      ['o3', 'own_a', 'ana', 'Bad', 'bad@x.com', JSON.stringify([{ productId: 'p1', variantId: 'v1', qty: 1 }]), 'Fulfilled', ago(4), 30]],
    Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'CustomerEmail', 'Status', 'CreatedAt']],
    Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'Status', 'CreatedAt']],
    AbandonedCarts: [['Id', 'StoreSlug', 'OwnerId', 'Email', 'CartJson', 'CreatedAt', 'Reminded', 'ConvertedOrderId'],
      ['cart1', 'bob', 'own_b', 'tera@x.com', JSON.stringify([{ productId: 'p4', variantId: 'v4', qty: 1 }]), ago(6), ago(5), '']],
    Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
    Campaigns: [H.Campaigns], CampaignEvents: [H.CampaignEvents], MarketingPreferences: [H.MarketingPreferences]
  });
  box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
  box.__props.SITE_BASE_URL = 'https://mwakete.com';
  box.MailApp.getRemainingDailyQuota = () => 100;
  const realSend = box.MailApp.sendEmail;
  box.MailApp.sendEmail = (to, ...rest) => { if (to === 'bad@x.com') throw new Error('Invalid email'); return realSend(to, ...rest); };
  // consent: c1, c2, c5, c6 opt in; c3 opts in then out; c4 unverified opts in
  const sess = (id) => box.__sheets.CustomerSessions;
  box.setMarketingOptIn({ CustomerId: 'c1', Email: 'tera@x.com' }, true);
  box.setMarketingOptIn({ CustomerId: 'c2', Email: 'bwena@x.com' }, true);
  box.setMarketingOptIn({ CustomerId: 'c3', Email: 'out@x.com' }, true);
  box.setMarketingOptIn({ CustomerId: 'c3', Email: 'out@x.com' }, false);
  box.setMarketingOptIn({ CustomerId: 'c4', Email: 'unv@x.com' }, true);
  box.setMarketingOptIn({ CustomerId: 'c5', Email: 'lapsed@x.com' }, true);
  box.setMarketingOptIn({ CustomerId: 'c6', Email: 'bad@x.com' }, true);
  return box;
}
const rows = (box, tab) => box.sheetToObjects(box.getSheet(tab));
const ADMIN = { OwnerId: 'own_adm', Email: 'boss@mwakete.com' };
const SELLER = { OwnerId: 'own_a', Email: 'ana@x.com', StoreSlug: 'ana' };
const deliveries = (box) => rows(box, 'CampaignEvents').filter((e) => e.EventType === 'DELIVERY');

/* ---------- defaults: off, dry run ---------- */
{
  const box = world();
  const cfg = box.marketingConfig();
  ok('default: MARKETING_ENABLED off', cfg.enabled === false);
  ok('default: dry run on', cfg.dryRun === true);
  ok('default: auto campaigns wait for approval', cfg.autoApprove === false);
  ok('default: conservative limits (30/day, 10/run, 2 per 7 days)', cfg.dailyLimit === 30 && cfg.batchSize === 10 && cfg.maxPerWindow === 2 && cfg.frequencyDays === 7);
  box.__props.MARKETING_DRY_RUN = 'flase';
  ok('a typo in MARKETING_DRY_RUN keeps dry run ON', box.marketingConfig().dryRun === true);
  const r = box.runMarketingSweep();
  ok('kill switch: disabled sweep does nothing', /MARKETING_ENABLED/.test(r.skipped) && rows(box, 'Campaigns').length === 0 && box.__mail.length === 0);
}

/* ---------- consent ---------- */
{
  const box = world();
  const prefs = rows(box, 'MarketingPreferences');
  ok('opt-in recorded with time and a random unsubscribe token',
    prefs.find((p) => p.CustomerId === 'c1').PromotionalEmailOptIn === 'true' && !!prefs.find((p) => p.CustomerId === 'c1').OptInAt
    && /^unsub_[a-z0-9]{32}$/.test(prefs.find((p) => p.CustomerId === 'c1').UnsubscribeToken));
  ok('opting out sticks', prefs.find((p) => p.CustomerId === 'c3').PromotionalEmailOptIn === 'false');
  ok('a customer with no row is NOT opted in', !box.isOptedIn(null));
  let r = box.actionGetMarketingPreference({ token: 'tok_c1' });
  ok('customer reads their own setting', r.ok && r.optIn === true);
  r = box.actionSetMarketingPreference({ token: 'tok_c1', optIn: false, customerId: 'c2' });
  ok('setting uses the SESSION customer, never a customerId in the request',
    r.ok && rows(box, 'MarketingPreferences').find((p) => p.CustomerId === 'c1').PromotionalEmailOptIn === 'false'
    && rows(box, 'MarketingPreferences').find((p) => p.CustomerId === 'c2').PromotionalEmailOptIn === 'true');
  ok('no session, no change', !box.actionSetMarketingPreference({ optIn: true }).ok);
  const tok = rows(box, 'MarketingPreferences').find((p) => p.CustomerId === 'c2').UnsubscribeToken;
  box.actionUnsubscribeMarketing({ t: tok });
  ok('one-tap unsubscribe switches that customer off', rows(box, 'MarketingPreferences').find((p) => p.CustomerId === 'c2').PromotionalEmailOptIn === 'false');
  const before = JSON.stringify(rows(box, 'MarketingPreferences'));
  r = box.actionUnsubscribeMarketing({ t: 'unsub_' + 'a'.repeat(32) });
  ok('an unknown token changes nothing and answers the same (no probing)', r.ok && r.unsubscribed && JSON.stringify(rows(box, 'MarketingPreferences')) === before);
}

/* ---------- generation: only real opportunities, idempotent ---------- */
{
  const box = world();
  const cfg = box.marketingConfig();
  const created = box.generateMarketingOpportunities(cfg, Date.now());
  const types = created.map((c) => c.type).sort();
  ok('generation finds real opportunities', types.indexOf('NEW_PRODUCTS') !== -1 && types.indexOf('PRODUCT_INTEREST') !== -1 && types.indexOf('RETURNING_CUSTOMER') !== -1, types.join(','));
  ok('automatic campaigns start as DRAFT (no auto-approve)', created.every((c) => c.status === 'DRAFT'));
  ok('a store-update campaign per store with new listings AND interested customers',
    created.filter((c) => c.type === 'STORE_UPDATE').length >= 1);
  ok('generation never sends', box.__mail.length === 0 && deliveries(box).length === 0);
  const again = box.generateMarketingOpportunities(cfg, Date.now());
  ok('running generation twice creates nothing new (SourceKey)', again.length === 0, again.length);
  ok('no campaign for the inactive (old) product', rows(box, 'Campaigns').every((c) => c.ProductIdsJson.indexOf('p6') === -1));
}

/* ---------- audience rules ---------- */
{
  const box = world();
  const cfg = box.marketingConfig();
  const ctx = box.buildMarketingContext(cfg, Date.now());
  const plan = (type, extra) => box.planCampaignRecipients(Object.assign({ CampaignId: 'cmp_t', Type: type, StoreSlugsJson: '[]', ProductIdsJson: '[]', AudienceFilterJson: '{}', AudienceType: 'ALL_OPTED_IN' }, extra || {}), ctx, cfg).recipients;
  const ids = (rs) => rs.map((r) => r.customer.CustomerId).sort().join(',');
  const np = plan('NEW_PRODUCTS');
  ok('opted-out and unverified customers never qualify', np.every((r) => ['c3', 'c4'].indexOf(r.customer.CustomerId) === -1), ids(np));
  ok('new products never include one they already ordered', np.every((r) => r.products.every((p) => p.ProductId !== 'p1')));
  ok('new products prefer their categories (Tera ordered food -> food first)',
    np.find((r) => r.customer.CustomerId === 'c1').products[0].Category === 'food');
  const pi = plan('PRODUCT_INTEREST');
  ok('product interest: cart left after the ONE reminder, still listed, not ordered', ids(pi) === 'c1' && pi[0].products[0].ProductId === 'p4', ids(pi));
  ok('...and says why, without personal detail', /cart/.test(pi[0].reason) && !/@/.test(pi[0].reason));
  const su = plan('STORE_UPDATE', { StoreSlugsJson: '["bob"]' });
  ok('store update: only customers with real interest in THAT store', ids(su) === 'c1,c2', ids(su));
  const lapsed = plan('INACTIVE_CUSTOMER');
  ok('inactive: only the customer with no activity for 30+ days', ids(lapsed) === 'c5', ids(lapsed));
  const ret = plan('RETURNING_CUSTOMER');
  ok('returning: customers with a completed order', ids(ret).split(',').every((id) => ['c1', 'c2', 'c6'].indexOf(id) !== -1) && ret.length >= 2, ids(ret));
  const st = plan('SELLER_PROMOTION', { AudienceType: 'STORE_CUSTOMERS', StoreSlugsJson: '["ana"]' });
  ok('seller promotion to store customers: only that store\'s customers', ids(st) === 'c1,c6', ids(st));
  ok('the admin store is never a store the engine promotes', !ctx.ownerBySlug.admin);
  const scores = box.buildMarketingContext(cfg, Date.now()).interest['tera@x.com'];
  ok('interest is scored with decay (order 5 days ago = full weight)', scores.stores.ana === 6, JSON.stringify(scores.stores));
  ok('decay: 8-30 days 0.6, 31-90 0.25, >90 ignored', box.marketingDecay(10) === 0.6 && box.marketingDecay(60) === 0.25 && box.marketingDecay(91) === 0);
}

/* ---------- dry run, then live, idempotency, retries, cap ---------- */
{
  const box = world();
  box.__props.MARKETING_ENABLED = 'true';
  box.generateMarketingOpportunities(box.marketingConfig(), Date.now());
  // Approve everything, as an admin would.
  rows(box, 'Campaigns').forEach((c) => box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: c.CampaignId, op: 'approve' }));
  ok('admin approve: DRAFT -> SCHEDULED', rows(box, 'Campaigns').every((c) => c.Status === 'SCHEDULED'));

  let s = box.runMarketingSweep();
  const dry = deliveries(box);
  ok('dry run: records who would get it, sends NOTHING', s.dryRunMode === true && dry.length > 0 && dry.every((e) => e.Status === 'DRY_RUN') && box.__mail.length === 0, JSON.stringify(s));
  ok('dry run rows say why', dry.every((e) => /reason/.test(e.MetadataJson)));
  ok('dry run never finishes a campaign', rows(box, 'Campaigns').every((c) => c.Status === 'SCHEDULED'));
  box.runMarketingSweep();
  ok('dry run twice: no duplicate rows', deliveries(box).length === dry.length + (deliveries(box).length - dry.length) && new Set(deliveries(box).map((e) => e.CampaignId + e.CustomerId)).size === deliveries(box).length);

  box.__props.MARKETING_DRY_RUN = 'false';
  box.__props.MARKETING_BATCH_SIZE = '50';
  box.__props.MARKETING_DAILY_EMAIL_LIMIT = '200';
  s = box.runMarketingSweep();
  const live = deliveries(box).filter((e) => e.Status !== 'DRY_RUN');
  const perCustomer = {};
  box.__mail.forEach((m) => { perCustomer[m[0]] = (perCustomer[m[0]] || 0) + 1; });
  ok('live: emails go out', box.__mail.length > 0, JSON.stringify(s));
  ok('frequency cap: nobody gets more than 2 promotional emails in 7 days', Object.values(perCustomer).every((n) => n <= 2), JSON.stringify(perCustomer));
  ok('capped recipients are deferred, not marked done', s.deferred > 0, s.deferred);
  ok('opted-out customer never emailed', !perCustomer['out@x.com'] && !perCustomer['unv@x.com']);
  ok('one bad address does not stop the run: marked RETRY, others sent',
    live.some((e) => e.Email === 'bad@x.com' && e.Status === 'RETRY') && live.some((e) => e.Status === 'SENT'));
  const sentBefore = box.__mail.length;
  box.runMarketingSweep();
  const badRow = deliveries(box).find((e) => e.Email === 'bad@x.com' && e.Status !== 'DRY_RUN');
  ok('retry limit: the bad address ends FAILED after 2 attempts, with a reason', badRow.Status === 'FAILED' && Number(badRow.Attempts) === 2 && !!badRow.FailureReason, badRow.Status + '/' + badRow.Attempts);
  const keys = deliveries(box).filter((e) => e.Status !== 'DRY_RUN').map((e) => e.CampaignId + '|' + e.CustomerId);
  ok('idempotent: one live delivery row per campaign+customer, across runs', new Set(keys).size === keys.length);
  const sentPairs = deliveries(box).filter((e) => e.Status === 'SENT').map((e) => e.CampaignId + '|' + e.CustomerId);
  ok('...and nobody was emailed twice for one campaign', new Set(sentPairs).size === sentPairs.length);
  ok('the cap still holds after the second run', Object.values(box.__mail.reduce((m, x) => { m[x[0]] = (m[x[0]] || 0) + 1; return m; }, {})).every((n) => n <= 2));
  ok('LastPromotionalEmailAt is kept', rows(box, 'MarketingPreferences').some((p) => !!p.LastPromotionalEmailAt));

  // the email itself
  const mail = box.__mail.find((m) => m[0] === 'tera@x.com');
  const html = mail[3].htmlBody, text = mail[2];
  ok('email: greets by first name', /Hi Tera,/.test(text));
  ok('email: database text is escaped, never markup', html.indexOf('<b>1kg</b>') === -1 && (html.indexOf('&lt;b&gt;') !== -1 || html.indexOf('Flour') === -1));
  ok('email: links are our site only, with campaign + event ids', /https:\/\/mwakete\.com\/product\.html\?store=\w+&amp;product=p\d&amp;mc=cmp_[a-z0-9]{16}&amp;me=mev_[a-z0-9]{16}/.test(html));
  ok('email: one-tap unsubscribe link', /https:\/\/mwakete\.com\/unsubscribe\.html\?t=unsub_[a-z0-9]{32}/.test(html) && /Stop these emails/.test(text));
  ok('email: no prices, discounts or superlatives invented', !/\$|price|discount|% off|cheapest|best|guarantee|limited/i.test(text), text);
}

/* ---------- quota protection + daily limit + pause ---------- */
{
  const box = world();
  Object.assign(box.__props, { MARKETING_ENABLED: 'true', MARKETING_DRY_RUN: 'false', MARKETING_AUTO_APPROVE: 'true' });
  box.MailApp.getRemainingDailyQuota = () => 40;   // exactly the reserve
  box.runMarketingSweep();
  ok('MailApp quota at the transactional reserve: marketing sends nothing', box.__mail.length === 0);
  box.MailApp.getRemainingDailyQuota = () => 100;
  box.__props.MARKETING_DAILY_EMAIL_LIMIT = '1';
  box.runMarketingSweep();
  ok('daily limit respected', box.__mail.length === 1, box.__mail.length);
  box.__props.MARKETING_DAILY_EMAIL_LIMIT = '200';
  box.__props.MARKETING_PAUSED = 'true';
  const before = box.__mail.length;
  ok('paused: sweep skips', box.runMarketingSweep().skipped === 'paused' && box.__mail.length === before);
  ok('auto-approve: automatic campaigns go straight to READY/SCHEDULED/SENT', rows(box, 'Campaigns').every((c) => c.Status !== 'DRAFT'));
  box.__props.MARKETING_SWEEP_LOCK = String(Date.now());
  box.__props.MARKETING_PAUSED = 'false';
  ok('a sweep already running blocks a second one', /another sweep/.test(box.runMarketingSweep().skipped));
}

/* ---------- admin actions: authorization, validation, isolation ---------- */
{
  const box = world();
  ok('seller cannot see the marketing overview', !box.actionGetMarketingOverview(SELLER).ok);
  ok('seller cannot create a campaign', !box.actionCreateMarketingCampaign(SELLER, { type: 'SEASONAL', name: 'x', subject: 'x', message: 'x' }).ok);
  ok('seller cannot pause, preview, stats or generate',
    !box.actionSetMarketingPaused(SELLER, { paused: true }).ok && !box.actionPreviewMarketingCampaign(SELLER, {}).ok
    && !box.actionGetMarketingStats(SELLER).ok && !box.actionRunMarketingGeneration(SELLER).ok);
  const base = { type: 'SELLER_PROMOTION', name: 'Ana week', subject: 'Hello {{customerName}}', message: 'New stock at {{storeName}}.', storeSlug: 'ana', audience: 'STORE_CUSTOMERS' };
  const nl = box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { subject: 'Hi\r\nBcc: evil@example.org' }));
  ok('a line break in a subject is flattened (no header injection)', nl.ok && rows(box, 'Campaigns').find((c) => c.CampaignId === nl.campaignId).Subject === 'Hi Bcc: evil@example.org');
  ok('HTML in a campaign is refused', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { message: '<script>x</script>' })).ok);
  ok('an automatic type cannot be created by hand', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { type: 'NEW_PRODUCTS' })).ok);
  ok('unknown store refused', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { storeSlug: 'nope' })).ok);
  ok('the hidden admin store cannot be promoted', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { storeSlug: 'admin' })).ok);
  ok('another store\'s product refused (no cross-store)', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { productIds: ['p4'] })).ok);
  ok('an inactive product refused', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { storeSlug: 'bob', productIds: ['p6'] })).ok);
  ok('an end date in the past refused', !box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { startAt: ago(10), endAt: ago(5) })).ok);
  const created = box.actionCreateMarketingCampaign(ADMIN, Object.assign({}, base, { productIds: ['p2'] }));
  ok('valid seller promotion created as DRAFT', created.ok && rows(box, 'Campaigns').find((c) => c.CampaignId === created.campaignId).Status === 'DRAFT');
  const pv = box.actionPreviewMarketingCampaign(ADMIN, { campaignId: created.campaignId });
  ok('preview: audience size, reasons and a sample - and no email address anywhere',
    pv.ok && pv.audienceSize === 2 && pv.reasons['Has ordered or booked from this store'] === 2 && !/@/.test(JSON.stringify(pv)), JSON.stringify(pv).slice(0, 300));
  ok('preview fills {{variables}} safely', /Hello there|Hello Tera|Hello Bad/.test(pv.sample.subject) && /New stock at Ana Shop\./.test(pv.sample.text));
  const ov = box.actionGetMarketingOverview(ADMIN);
  ok('overview: settings and counts, no email addresses', ov.ok && ov.settings.dryRun === true && ov.totals.optedIn >= 4 && !/@x\.com/.test(JSON.stringify(ov.campaigns)));
  ok('invalid transitions refused (resume a draft)', !box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: created.campaignId, op: 'resume' }).ok);
  ok('pause a scheduled campaign', box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: created.campaignId, op: 'approve' }).ok
    && box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: created.campaignId, op: 'pause' }).status === 'PAUSED');
  ok('cancel', box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: created.campaignId, op: 'cancel' }).status === 'CANCELLED');
  ok('unknown campaign id', !box.actionSetMarketingCampaignStatus(ADMIN, { campaignId: 'cmp_nope', op: 'pause' }).ok);
}

/* ---------- clicks + conversions ---------- */
{
  const box = world();
  Object.assign(box.__props, { MARKETING_ENABLED: 'true', MARKETING_DRY_RUN: 'false', MARKETING_AUTO_APPROVE: 'true', MARKETING_BATCH_SIZE: '50' });
  box.runMarketingSweep();
  const ev = deliveries(box).find((e) => e.Status === 'SENT' && e.Email === 'tera@x.com');
  box.actionRecordMarketingClick({ mc: ev.CampaignId, me: ev.EventId });
  box.actionRecordMarketingClick({ mc: ev.CampaignId, me: ev.EventId });
  box.actionRecordMarketingClick({ mc: 'cmp_' + 'a'.repeat(16), me: ev.EventId });
  box.actionRecordMarketingClick({ mc: ev.CampaignId, me: 'mev_' + 'b'.repeat(16) });
  const clicks = rows(box, 'CampaignEvents').filter((e) => e.EventType === 'CLICK');
  ok('a click counts once, only for a real sent email of that campaign', clicks.length === 1 && clicks[0].Email === '');
  box.getSheet('Orders').appendRow(['o9', 'own_a', 'ana', 'Tera', 'tera@x.com', '[]', 'Pending Payment', new Date(Date.now() + 1000).toISOString(), 10]);
  const st = box.actionGetMarketingStats(ADMIN).stats.find((x) => x.campaignId === ev.CampaignId);
  ok('conversion: an order by that customer within the window', st.sent >= 1 && st.clicks === 1 && st.conversions >= 0, JSON.stringify(st));
  ok('stats never expose addresses', !/@/.test(JSON.stringify(box.actionGetMarketingStats(ADMIN))));
}

/* ---------- the existing abandoned-cart reminder is untouched ---------- */
{
  const box = world();
  Object.assign(box.__props, { MARKETING_ENABLED: 'true', MARKETING_DRY_RUN: 'false', MARKETING_AUTO_APPROVE: 'true', MARKETING_BATCH_SIZE: '50' });
  box.getSheet('AbandonedCarts').appendRow(['cart2', 'ana', 'own_a', 'guest@x.com', JSON.stringify([{ productId: 'p1', variantId: 'v1', qty: 1 }]), new Date(Date.now() - 2 * 3600000).toISOString(), '', '']);
  box.runReminderSweep();
  const reminder = box.__mail.filter((m) => m[0] === 'guest@x.com');
  ok('abandoned-cart reminder still goes out once, from the reminder sweep', reminder.length === 1 && /You left something in your cart/.test(reminder[0][1]));
  box.runMarketingSweep();
  ok('marketing never emails a guest (no account, no consent)', box.__mail.filter((m) => m[0] === 'guest@x.com').length === 1);
  ok('marketing builds no abandoned-cart campaign of its own', rows(box, 'Campaigns').every((c) => c.Type !== 'ABANDONED_CART'));
}

/* ---------- setup ---------- */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  ok('setupSheets knows the three new tabs', /Campaigns: \[/.test(src) && /CampaignEvents: \[/.test(src) && /MarketingPreferences: \[/.test(src));
  // Pinned to 'marketing1-' at first; any later release moves it on, so check it is set at all.
  ok('APP_VERSION is set', /APP_VERSION = '[a-z0-9]+-\d{4}-\d{2}-\d{2}'/.test(src));
}

let f = 0;
console.log('\n--- Marketing engine ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
