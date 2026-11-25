/**
 * CESN Stage 8 - admin controls (CesnAdmin.gs) against the real backend via
 * gas-harness. Covers admin gating, reading config/volumes, validation, that a
 * saved limit actually changes the engine's behaviour, and that an admin
 * category toggle disables that category platform-wide.
 */
const { makeBox } = require('./lib/gas-harness.js');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  [' + JSON.stringify(e) + ']' : '')); } };
const OLD = new Date(Date.now() - 10 * 86400000).toISOString();

function env() {
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status'],
      ['own_s', 'bong', 'Bong Store', 'admin@x.test', 'active'],
      ['own_b', 'other', 'Other Store', 'seller@x.test', 'active']],
    StoreFollows: [['FollowId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt'], ['f1', 'cus_f', 'bong', 'active', 'true', OLD, OLD]],
    StoreLikes: [['LikeId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']],
    StoreMarketingConsents: [['ConsentId', 'CustomerId', 'StoreSlug', 'Status', 'OptInAt', 'WithdrawnAt', 'CreatedAt', 'UpdatedAt']],
    Notifications: [['NotificationId', 'CustomerId', 'StoreSlug', 'Category', 'Title', 'Body', 'ImageUrl', 'DeepLink', 'CampaignId', 'SourceKey', 'ReadAt', 'CreatedAt']],
    CesnAudit: [['EventId', 'StoreSlug', 'Category', 'SourceKey', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'CreatedAt']],
    PushSubscriptions: [['SubId', 'CustomerId', 'FcmToken', 'UserAgent', 'Platform', 'Status', 'LastSeenAt', 'CreatedAt'], ['s1', 'cus_f', 'DEV', '', 'web', 'active', OLD, OLD]],
    EngagementCampaigns: [['CampaignId', 'OwnerId', 'StoreSlug', 'Category', 'Title', 'Body', 'DeepLink', 'ImageUrl', 'Status', 'ScheduleAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'SentAt']]
  }, { guest: true });
  box.__props.ADMIN_EMAILS = 'admin@x.test';
  return box;
}
const admin = (box) => box.__sheets.Owners.objects().find((o) => o.OwnerId === 'own_s');
const seller = (box) => box.__sheets.Owners.objects().find((o) => o.OwnerId === 'own_b');

/* ---- gating ---- */
{
  const box = env();
  t('getCesnAdmin: a non-admin is refused', box.actionGetCesnAdmin(seller(box)).ok === false);
  t('setCesnConfig: a non-admin is refused', box.actionSetCesnConfig(seller(box), { maxPerDay: 1 }).ok === false);
  const r = box.actionGetCesnAdmin(admin(box));
  t('getCesnAdmin: an admin gets config + categories + volumes', r.ok && r.config && r.categories.length === 11 && !!r.volumes, r && r.categories && r.categories.length);
  t('getCesnAdmin: reports the push subscription count', r.pushSubscriptions === 1, r.pushSubscriptions);
}

/* ---- save + validation + effect ---- */
{
  const box = env();
  t('setCesnConfig: out-of-range value refused', box.actionSetCesnConfig(admin(box), { maxPerDay: 999 }).ok === false);
  const r = box.actionSetCesnConfig(admin(box), { maxPerDay: 5, minIntervalMin: 0, dropPct: 15 });
  t('setCesnConfig: a valid save succeeds and echoes the new config', r.ok && r.config.maxPerDay === 5 && r.config.dropPct === 15, r.config);
  t('setCesnConfig: persisted to Script Properties', box.__props.CESN_MAX_PER_DAY === '5' && box.__props.CESN_PRICE_DROP_PCT === '15');
  t('setCesnConfig: cesnConfig now reflects the new limit', box.cesnConfig().maxPerDay === 5 && box.cesnConfig().dropPct === 15);
  t('setCesnConfig: wrote an audit row', box.__sheets.CesnAudit.objects().some((a) => a.Category === 'admin_config' && a.SourceKey === 'admin:own_s'));
}

/* ---- a category toggle disables that category in the engine ---- */
{
  const box = env();
  box.actionSetCesnConfig(admin(box), { disabledCategories: ['price_drop', 'new_arrival'] });
  const off = box.emitEngagementEvent({ storeSlug: 'bong', category: 'price_drop', title: 'T', body: 'B', sourceKey: 's1' });
  t('an admin-disabled category is refused by the engine', off.reason === 'category-off' && off.queued === 0, off);
  const on = box.emitEngagementEvent({ storeSlug: 'bong', category: 'back_in_stock', title: 'T', body: 'B', sourceKey: 's2' });
  t('a still-enabled category keeps working', on.queued === 1, on);
}

/* ---- master switch off stops everything ---- */
{
  const box = env();
  box.actionSetCesnConfig(admin(box), { enabled: false });
  const r = box.emitEngagementEvent({ storeSlug: 'bong', category: 'back_in_stock', title: 'T', body: 'B', sourceKey: 's' });
  t('master switch off (via admin) stops all sends', r.reason === 'disabled' && r.queued === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
