/**
 * CESN Stage 7 - seller campaign management (SellerEngagement.gs) against the
 * real backend via gas-harness. Covers create/preview/validation, send through
 * the one engine gate (eligible audience only), no double-send, scheduling +
 * the scheduled processor, analytics (delivered/opened), and cross-store
 * isolation.
 */
const { makeBox } = require('./lib/gas-harness.js');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  [' + JSON.stringify(e) + ']' : '')); } };
const OLD = new Date(Date.now() - 10 * 86400000).toISOString();
const FUT = new Date(Date.now() + 86400000).toISOString();

function env() {
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status'], ['own_s', 'bong', 'Bong Store', 'active'], ['own_b', 'other', 'Other Store', 'active']],
    Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['otok', 'own_s', '', FUT], ['btok', 'own_b', '', FUT]],
    StoreFollows: [['FollowId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt'], ['f1', 'cus_f', 'bong', 'active', 'true', OLD, OLD]],
    StoreLikes: [['LikeId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']],
    StoreMarketingConsents: [['ConsentId', 'CustomerId', 'StoreSlug', 'Status', 'OptInAt', 'WithdrawnAt', 'CreatedAt', 'UpdatedAt'], ['c1', 'cus_s', 'bong', 'active', OLD, '', OLD, OLD]],
    Notifications: [['NotificationId', 'CustomerId', 'StoreSlug', 'Category', 'Title', 'Body', 'ImageUrl', 'DeepLink', 'CampaignId', 'SourceKey', 'ReadAt', 'CreatedAt']],
    CesnAudit: [['EventId', 'StoreSlug', 'Category', 'SourceKey', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'CreatedAt']],
    PushSubscriptions: [['SubId', 'CustomerId', 'FcmToken', 'UserAgent', 'Platform', 'Status', 'LastSeenAt', 'CreatedAt']],
    EngagementCampaigns: [['CampaignId', 'OwnerId', 'StoreSlug', 'Category', 'Title', 'Body', 'DeepLink', 'ImageUrl', 'Status', 'ScheduleAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'SentAt']]
  }, { guest: true });
  return box;
}
const S = (box) => box.requireAuth('otok');     // store owner
const B = (box) => box.requireAuth('btok');     // other store owner

/* ---- create + validation ---- */
{
  const box = env();
  const bad = box.actionCreateEngagementCampaign(S(box), { category: 'price_drop', title: 'x', body: 'y' });
  t('an automatic category cannot be hand-created', bad.ok === false);
  const noTitle = box.actionCreateEngagementCampaign(S(box), { category: 'flash_sale', body: 'y' });
  t('a title is required', noTitle.ok === false);
  const ok1 = box.actionCreateEngagementCampaign(S(box), { category: 'flash_sale', title: 'Weekend sale', body: '20% off rice' });
  t('create a manual campaign (flash_sale) -> ok with an id', ok1.ok === true && !!ok1.campaignId);
}

/* ---- preview shows the eligible audience, not a send ---- */
{
  const box = env();
  const pv = box.actionPreviewEngagementCampaign(S(box), { category: 'flash_sale', title: 'T', body: 'B' });
  t('preview: flash_sale audience = subscribers (cus_s) = 1', pv.ok && pv.eligibleAudience === 1 && pv.audienceType === 'subscribers', pv);
  t('preview did not create any notification', box.__sheets.Notifications.objects().length === 0);
}

/* ---- send goes only to the eligible audience, once ---- */
{
  const box = env();
  const id = box.actionCreateEngagementCampaign(S(box), { category: 'flash_sale', title: 'Sale', body: '20% off' }).campaignId;
  const r = box.actionSendEngagementCampaign(S(box), { campaignId: id });
  const notes = box.__sheets.Notifications.objects();
  t('send: queued to the 1 subscriber only (not the follower)', r.ok && r.queued === 1 && notes.length === 1 && notes[0].CustomerId === 'cus_s', { r, who: notes.map((n) => n.CustomerId) });
  t('send: the notification carries the campaign source key', notes[0].SourceKey === 'camp:' + id && notes[0].Category === 'flash_sale');
  const again = box.actionSendEngagementCampaign(S(box), { campaignId: id });
  t('a sent campaign cannot be sent again', again.ok === false && box.__sheets.Notifications.objects().length === 1);
}

/* ---- analytics: delivered + opened ---- */
{
  const box = env();
  const id = box.actionCreateEngagementCampaign(S(box), { category: 'manual_promo', title: 'Hi', body: 'B' }).campaignId;
  box.actionSendEngagementCampaign(S(box), { campaignId: id });
  let list = box.actionListEngagementCampaigns(S(box));
  const c1 = list.campaigns.find((c) => c.campaignId === id);
  t('analytics: delivered counted, opened 0 before any read', c1.analytics.inAppDelivered >= 1 && c1.analytics.opened === 0, c1.analytics);
  // Mark one recipient's notification read.
  const note = box.__sheets.Notifications.objects().find((n) => n.SourceKey === 'camp:' + id);
  const sheet = box.__sheets.Notifications;
  const rowIdx = sheet.grid.findIndex((r) => r[0] === note.NotificationId);
  sheet.grid[rowIdx][sheet.grid[0].indexOf('ReadAt')] = new Date().toISOString();
  list = box.actionListEngagementCampaigns(S(box));
  const c2 = list.campaigns.find((c) => c.campaignId === id);
  t('analytics: opened counts an in-app read', c2.analytics.opened === 1, c2.analytics);
  t('list offers the manual categories, not the automatic ones', list.manualCategories.some((m) => m.key === 'flash_sale') && !list.manualCategories.some((m) => m.key === 'price_drop'));
}

/* ---- scheduling + the scheduled processor ---- */
{
  const box = env();
  const id = box.actionCreateEngagementCampaign(S(box), { category: 'seasonal', title: 'Xmas', body: 'B' }).campaignId;
  t('cannot schedule in the past', box.actionSetEngagementCampaignStatus(S(box), { campaignId: id, status: 'scheduled', scheduleAt: OLD }).ok === false);
  const sc = box.actionSetEngagementCampaignStatus(S(box), { campaignId: id, status: 'scheduled', scheduleAt: FUT });
  t('schedule for the future -> ok', sc.ok === true);
  t('a not-yet-due scheduled campaign is not sent by the processor', box.processDueEngagementCampaigns().processed === 0 && box.__sheets.Notifications.objects().length === 0);
  // Make it due.
  const sheet = box.__sheets.EngagementCampaigns;
  const rowIdx = sheet.grid.findIndex((r) => r[0] === id);
  sheet.grid[rowIdx][sheet.grid[0].indexOf('ScheduleAt')] = OLD;
  const done = box.processDueEngagementCampaigns();
  t('a due scheduled campaign is sent by the processor', done.processed === 1 && box.__sheets.Notifications.objects().length === 1);
}

/* ---- cross-store isolation ---- */
{
  const box = env();
  const id = box.actionCreateEngagementCampaign(S(box), { category: 'flash_sale', title: 'Mine', body: 'B' }).campaignId;
  t('another store cannot send my campaign', box.actionSendEngagementCampaign(B(box), { campaignId: id }).ok === false);
  t('another store cannot edit my campaign', box.actionUpdateEngagementCampaign(B(box), { campaignId: id, title: 'hacked' }).ok === false);
  t('the other store sees none of my campaigns', box.actionListEngagementCampaigns(B(box)).campaigns.length === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
