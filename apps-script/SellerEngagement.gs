/**
 * Seller campaign management (CESN Stage 7). Lets a store compose, preview,
 * schedule, send, pause and cancel engagement notifications, and see honest
 * analytics. Every send goes through emitEngagementEvent (EngagementEngine.gs),
 * so a seller can NEVER reach a customer outside the eligible, consented
 * audience, nor exceed Mwakete's frequency caps - manual campaigns and
 * automatic triggers share the exact same gate.
 *
 * Sellers may only use the MANUAL categories (auto ones - price drop, new
 * arrival, back in stock - are driven by PriceWatch from verified data and
 * cannot be hand-sent). All actions are owner-authed and scoped to the caller's
 * own store.
 */

var ENGAGEMENT_CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sent', 'paused', 'cancelled'];

function cesnManualCategories_() {
  return Object.keys(CESN_CATEGORIES).filter(function (k) { return CESN_CATEGORIES[k].auto === false; });
}

function cesnCleanText_(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 160);
}

function campaignOwnedRow_(owner, id) {
  var rows = sheetToObjects(getSheet('EngagementCampaigns')).filter(function (r) {
    return String(r.CampaignId) === String(id) && String(r.OwnerId) === String(owner.OwnerId);
  });
  return rows[0] || null;
}

// Honest analytics from what we can actually observe. In-app "delivered" = the
// rows the engine created; "opened" = those since read. Push delivery/opens and
// link clicks are not server-verifiable, and are reported as such, never faked.
function campaignAnalytics_(row) {
  var sourceKey = 'camp:' + row.CampaignId;
  var notes = sheetToObjects(getSheet('Notifications')).filter(function (n) { return String(n.SourceKey) === sourceKey; });
  var opened = notes.filter(function (n) { return !!String(n.ReadAt); }).length;
  return {
    eligibleAudience: Number(row.Audience) || 0,
    inAppDelivered: notes.length,          // = queued to the in-app centre
    opened: opened,                        // in-app reads (measurable)
    skippedFrequency: Number(row.SkippedFreq) || 0,
    skippedDuplicate: Number(row.SkippedDup) || 0
  };
}

function campaignPublic_(row) {
  return {
    campaignId: row.CampaignId, category: row.Category, title: row.Title, body: row.Body,
    deepLink: row.DeepLink, imageUrl: row.ImageUrl, status: row.Status, scheduleAt: row.ScheduleAt,
    createdAt: row.CreatedAt, sentAt: row.SentAt, analytics: campaignAnalytics_(row)
  };
}

/* ---- Create / edit ---- */

function actionCreateEngagementCampaign(owner, body) {
  var category = String(body.category || '');
  if (cesnManualCategories_().indexOf(category) === -1) return fail('That notification type cannot be sent by hand.');
  var title = cesnCleanText_(body.title, 80);
  var text = cesnCleanText_(body.body, 300);
  if (!title) return fail('A title is required.');
  if (!text) return fail('A message is required.');
  var now = nowIso();
  var id = newId('ecmp');
  appendRowFromObject(getSheet('EngagementCampaigns'), {
    CampaignId: id, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Category: category,
    Title: title, Body: text, DeepLink: cesnCleanText_(body.deepLink, 200), ImageUrl: cesnCleanText_(body.imageUrl, 400),
    Status: 'draft', ScheduleAt: '', CreatedAt: now, UpdatedAt: now, CreatedBy: owner.OwnerId,
    Audience: '', Queued: '', SkippedFreq: '', SkippedDup: '', SentAt: ''
  });
  return ok({ campaignId: id });
}

function actionUpdateEngagementCampaign(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = campaignOwnedRow_(owner, body.campaignId);
    if (!row) return fail('Campaign not found.');
    if (['sent', 'cancelled'].indexOf(String(row.Status)) !== -1) return fail('A sent or cancelled campaign cannot be edited.');
    var patch = { UpdatedAt: nowIso() };
    if (body.title !== undefined) { patch.Title = cesnCleanText_(body.title, 80); if (!patch.Title) return fail('A title is required.'); }
    if (body.body !== undefined) { patch.Body = cesnCleanText_(body.body, 300); if (!patch.Body) return fail('A message is required.'); }
    if (body.deepLink !== undefined) patch.DeepLink = cesnCleanText_(body.deepLink, 200);
    if (body.imageUrl !== undefined) patch.ImageUrl = cesnCleanText_(body.imageUrl, 400);
    if (body.category !== undefined) {
      if (cesnManualCategories_().indexOf(String(body.category)) === -1) return fail('That notification type cannot be sent by hand.');
      patch.Category = String(body.category);
    }
    updateRowFromObject(getSheet('EngagementCampaigns'), row.__row, patch);
  } finally { lock.releaseLock(); }
  return ok({ updated: true });
}

/* ---- Preview (no send): how many eligible customers would get it ---- */

function actionPreviewEngagementCampaign(owner, body) {
  var category = String(body.category || '');
  if (cesnManualCategories_().indexOf(category) === -1) return fail('That notification type cannot be sent by hand.');
  var audienceType = CESN_CATEGORIES[category].audience;
  var audience = cesnAudienceFor(owner.StoreSlug, audienceType).length;
  return ok({ category: category, audienceType: audienceType, eligibleAudience: audience,
    title: cesnCleanText_(body.title, 80), body: cesnCleanText_(body.body, 300) });
}

/* ---- List (with analytics) ---- */

function actionListEngagementCampaigns(owner) {
  var rows = sheetToObjects(getSheet('EngagementCampaigns')).filter(function (r) { return String(r.OwnerId) === String(owner.OwnerId); });
  rows.sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  return ok({ campaigns: rows.map(campaignPublic_), manualCategories: cesnManualCategories_().map(function (k) { return { key: k, label: CESN_CATEGORIES[k].label }; }) });
}

/* ---- Send now ---- */

function actionSendEngagementCampaign(owner, body) {
  var row, id;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    row = campaignOwnedRow_(owner, body.campaignId);
    if (!row) return fail('Campaign not found.');
    if (['sent', 'cancelled'].indexOf(String(row.Status)) !== -1) return fail('That campaign has already been ' + row.Status + '.');
    id = row.CampaignId;
    // Mark it sending inside the lock so a double tap cannot send twice; the
    // actual fan-out (network for push) happens after the lock is released.
    updateRowFromObject(getSheet('EngagementCampaigns'), row.__row, { Status: 'sent', SentAt: nowIso(), UpdatedAt: nowIso() });
  } finally { lock.releaseLock(); }
  return ok(sendCampaignNow_(row));
}

// Shared by send-now and the scheduled processor. Not locked (does push I/O).
function sendCampaignNow_(row) {
  var res = emitEngagementEvent({
    storeSlug: row.StoreSlug, category: row.Category, title: row.Title, body: row.Body,
    deepLink: row.DeepLink, imageUrl: row.ImageUrl, campaignId: row.CampaignId, sourceKey: 'camp:' + row.CampaignId
  });
  // Record the outcome for analytics.
  var fresh = sheetToObjects(getSheet('EngagementCampaigns')).filter(function (r) { return String(r.CampaignId) === String(row.CampaignId); })[0];
  if (fresh) updateRowFromObject(getSheet('EngagementCampaigns'), fresh.__row, {
    Audience: res.audience || 0, Queued: res.queued || 0, SkippedFreq: res.skippedFreq || 0, SkippedDup: res.skippedDup || 0, UpdatedAt: nowIso()
  });
  return { sent: true, queued: res.queued || 0, eligibleAudience: res.audience || 0,
    skippedFrequency: res.skippedFreq || 0, skippedDuplicate: res.skippedDup || 0, reason: res.reason };
}

/* ---- Schedule / pause / cancel ---- */

function actionSetEngagementCampaignStatus(owner, body) {
  var want = String(body.status || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = campaignOwnedRow_(owner, body.campaignId);
    if (!row) return fail('Campaign not found.');
    var cur = String(row.Status);
    if (cur === 'sent' || cur === 'cancelled') return fail('A sent or cancelled campaign cannot change.');
    var patch = { UpdatedAt: nowIso() };
    if (want === 'scheduled') {
      var when = new Date(body.scheduleAt);
      if (isNaN(when.getTime()) || when.getTime() <= Date.now()) return fail('Choose a future time to schedule.');
      patch.Status = 'scheduled'; patch.ScheduleAt = when.toISOString();
    } else if (want === 'paused') {
      patch.Status = 'paused';
    } else if (want === 'draft') {
      patch.Status = 'draft'; patch.ScheduleAt = '';
    } else if (want === 'cancelled') {
      patch.Status = 'cancelled';
    } else { return fail('Unknown status.'); }
    updateRowFromObject(getSheet('EngagementCampaigns'), row.__row, patch);
  } finally { lock.releaseLock(); }
  return ok({ status: want });
}

/* ---- Scheduled sends (called by runEngagementSweep, system context) ---- */

function processDueEngagementCampaigns() {
  var now = Date.now();
  var due = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('EngagementCampaigns');
    sheetToObjects(sheet).forEach(function (r) {
      if (String(r.Status) !== 'scheduled') return;
      var at = new Date(r.ScheduleAt).getTime();
      if (isNaN(at) || at > now) return;
      updateRowFromObject(sheet, r.__row, { Status: 'sent', SentAt: nowIso(), UpdatedAt: nowIso() });  // claim before sending
      due.push(r);
    });
  } finally { lock.releaseLock(); }
  due.forEach(function (r) { try { sendCampaignNow_(r); } catch (e) { /* one bad campaign never stops the rest */ } });
  return { processed: due.length };
}
