/**
 * Mwakete Contacts & SMS - campaigns (Oct 2026, docs/contacts-sms-architecture.md).
 *
 * A campaign is built as a DRAFT (recipients from groups and/or picked
 * contacts, minus exclusions; a message with personalisation; a phone and a
 * SIM; a sending interval; optionally a time). smsCampaignEstimate shows who
 * would get it and who would not (opted out, no promotional consent, bad
 * number), every message's segment count, and previews.
 *
 * Nothing is sent until the store APPROVES it: smsCampaignApprove re-works the
 * recipients and must be told the same recipient count the store was shown
 * (so a page refresh or a stale screen can never start a campaign), then
 * writes one SmsMessages row per recipient - opted-out numbers as
 * 'suppressed', never sent. The phone takes them from there (SmsDevices.gs).
 */

var SMS_CAMPAIGN_HEADERS = ['CampaignId', 'OwnerId', 'Name', 'Kind', 'Body', 'Status', 'GroupIdsJson', 'ContactIdsJson', 'ExcludeIdsJson', 'DeviceId', 'SimKey',
  'IntervalSeconds', 'ScheduledAt', 'Recipients', 'Suppressed', 'Segments', 'ApprovedAt', 'ApprovedBy', 'StartedAt', 'CompletedAt', 'CancelReason',
  'Totals', 'CreatedAt', 'UpdatedAt'];
var SMS_MESSAGE_HEADERS = ['MessageId', 'CampaignId', 'OwnerId', 'ContactId', 'Phone', 'Body', 'Segments', 'Encoding', 'Status', 'DeviceId', 'SimKey', 'Attempts',
  'Error', 'ClaimedAt', 'SubmittedAt', 'SentAt', 'DeliveredAt', 'CreatedAt', 'UpdatedAt'];

function smsCampaignsSheet() { return hubSheet('SmsCampaigns', SMS_CAMPAIGN_HEADERS); }
function smsMessagesSheet() { return hubSheet('SmsMessages', SMS_MESSAGE_HEADERS); }

function smsOwnerCampaign(owner, campaignId) {
  return smsRows('SmsCampaigns').filter(function (c) { return c.OwnerId === owner.OwnerId && c.CampaignId === String(campaignId || ''); })[0] || null;
}

function smsCampaignView(c) {
  return {
    campaignId: c.CampaignId, name: c.Name, kind: c.Kind, kindLabel: SMS_KIND_LABEL[c.Kind] || c.Kind, body: c.Body, status: c.Status,
    statusLabel: SMS_CAMPAIGN_STATUS_LABEL[c.Status] || c.Status, groupIds: ctParse(c.GroupIdsJson, []).filter(function (g) { return g !== SMS_ALL_CONTACTS; }),
    allContacts: ctParse(c.GroupIdsJson, []).indexOf(SMS_ALL_CONTACTS) !== -1, contactIds: ctParse(c.ContactIdsJson, []),
    excludeIds: ctParse(c.ExcludeIdsJson, []), deviceId: c.DeviceId, simKey: c.SimKey, intervalSeconds: Number(c.IntervalSeconds) || 0,
    scheduledAt: c.ScheduledAt || '', recipients: Number(c.Recipients) || 0, suppressed: Number(c.Suppressed) || 0, segments: Number(c.Segments) || 0,
    approvedAt: c.ApprovedAt || '', startedAt: c.StartedAt || '', completedAt: c.CompletedAt || '', cancelReason: c.CancelReason || '',
    totals: ctParse(c.Totals, {}), createdAt: c.CreatedAt, updatedAt: c.UpdatedAt
  };
}

/* ==================== recipients ==================== */

/**
 * Who a campaign would reach. { send: [{contact, render, info}], skipped: {reason: [contactViews]}, segments }
 * groupIds and contactIds are unioned, excludeIds removed, each number once.
 */
function smsResolveRecipients(owner, spec) {
  var groupIds = Array.isArray(spec.groupIds) ? spec.groupIds.map(String) : [];
  var contactIds = Array.isArray(spec.contactIds) ? spec.contactIds.map(String) : [];
  var exclude = {};
  (Array.isArray(spec.excludeIds) ? spec.excludeIds : []).forEach(function (id) { exclude[String(id)] = true; });
  var wantIds = {};
  var everyone = groupIds.indexOf(SMS_ALL_CONTACTS) !== -1;
  contactIds.forEach(function (id) { wantIds[id] = true; });
  if (groupIds.length && !everyone) {
    var gset = {};
    ownerGroups(owner).forEach(function (g) { if (groupIds.indexOf(g.GroupId) !== -1) gset[g.GroupId] = true; });
    smsRows('ContactGroupMembers').filter(function (m) { return m.OwnerId === owner.OwnerId && gset[m.GroupId]; }).forEach(function (m) { wantIds[m.ContactId] = true; });
  }
  var suppressed = ownerSuppressed(owner);
  var kind = SMS_KINDS.indexOf(spec.kind) !== -1 ? spec.kind : 'promotional';
  var seenPhone = {};
  var send = [], skipped = { opted_out: [], no_consent: [], invalid_number: [], not_mobile: [], duplicate_number: [], too_long: [] };
  var segments = 0;
  ownerContactRows(owner).forEach(function (c) {
    if ((!everyone && !wantIds[c.ContactId]) || exclude[c.ContactId]) return;
    var may = contactMaySend(c, kind, suppressed);
    if (!may.ok) { skipped[may.reason].push(contactView(c)); return; }
    if (seenPhone[c.Phone]) { skipped.duplicate_number.push(contactView(c)); return; }
    seenPhone[c.Phone] = true;
    var render = smsRender(spec.body, { firstName: c.FirstName, lastName: c.LastName, businessName: c.BusinessName, island: c.Island, village: c.Village });
    var info = smsSegmentInfo(render.text);
    if (!render.text || info.segments > SMS_MAX_SEGMENTS) { skipped.too_long.push(contactView(c)); return; }
    segments += info.segments;
    send.push({ contact: c, render: render, info: info });
  });
  return { send: send, skipped: skipped, segments: segments, kind: kind };
}

// Stored in GroupIdsJson for "all my contacts" (no new column).
var SMS_ALL_CONTACTS = '__all__';

function smsCampaignSpecFrom(body) {
  var groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String).filter(function (g) { return g !== SMS_ALL_CONTACTS; }).slice(0, 50) : [];
  if (body.allContacts === true || (Array.isArray(body.groupIds) && body.groupIds.indexOf(SMS_ALL_CONTACTS) !== -1)) groupIds = [SMS_ALL_CONTACTS];
  return { name: ctText(body.name, 80), kind: SMS_KINDS.indexOf(body.kind) !== -1 ? body.kind : 'promotional', body: String(body.body || '').slice(0, 2000),
    groupIds: groupIds, contactIds: Array.isArray(body.contactIds) ? body.contactIds.slice(0, 5000) : [],
    excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds.slice(0, 5000) : [] };
}

/** body: kind, body, groupIds, contactIds, excludeIds. What sending would look like - nothing is saved. */
function actionSmsCampaignEstimate(owner, body) {
  var spec = smsCampaignSpecFrom(body || {});
  if (!spec.body.trim()) return fail('Write the message.');
  var unknown = smsRender(spec.body, {}).unknown;
  if (unknown.length) return fail('Unknown field {' + unknown[0] + '}. Use ' + SMS_FIELDS.map(function (f) { return '{' + f + '}'; }).join(', ') + '.');
  var r = smsResolveRecipients(owner, spec);
  var L = smsLimits();
  var missing = {};
  r.send.forEach(function (x) { x.render.missing.forEach(function (f) { missing[f] = (missing[f] || 0) + 1; }); });
  var skippedCounts = {};
  Object.keys(r.skipped).forEach(function (k) { skippedCounts[k] = r.skipped[k].length; });
  var unicode = {};
  r.send.forEach(function (x) { x.info.unicodeChars.forEach(function (ch) { unicode[ch] = true; }); });
  return ok({
    recipients: r.send.length, segments: r.segments, skipped: skippedCounts,
    skippedSample: Object.keys(r.skipped).reduce(function (o, k) { o[k] = r.skipped[k].slice(0, 5).map(function (c) { return { name: contactDisplayName({ FirstName: c.firstName, LastName: c.lastName, BusinessName: c.businessName, Phone: c.phone }), phone: c.phone || c.phoneRaw }; }); return o; }, {}),
    template: smsSegmentInfo(spec.body), unicodeChars: Object.keys(unicode),
    missingFields: missing, previews: r.send.slice(0, 5).map(function (x) { return { name: contactDisplayName(x.contact), phone: x.contact.Phone, text: x.render.text, segments: x.info.segments, encoding: x.info.encoding }; }),
    tooMany: r.send.length > L.maxCampaignRecipients, maxRecipients: L.maxCampaignRecipients
  });
}

/* ==================== drafts ==================== */

/** body: campaignId?, name, kind, body, groupIds, contactIds, excludeIds, deviceId, simKey, intervalSeconds, scheduledAt. Saves a DRAFT. */
function actionSmsCampaignSave(owner, body) {
  body = body || {};
  var spec = smsCampaignSpecFrom(body);
  if (spec.name.length < 2) return fail('Give the campaign a name.');
  if (!spec.body.trim()) return fail('Write the message.');
  if (smsSegmentInfo(spec.body).segments > SMS_MAX_SEGMENTS) return fail('That message is too long (more than ' + SMS_MAX_SEGMENTS + ' SMS).');
  var L = smsLimits();
  var fields = {
    Name: spec.name, Kind: spec.kind, Body: spec.body, GroupIdsJson: JSON.stringify(spec.groupIds), ContactIdsJson: JSON.stringify(spec.contactIds),
    ExcludeIdsJson: JSON.stringify(spec.excludeIds), DeviceId: ctText(body.deviceId, 40), SimKey: ctText(body.simKey, 120),
    IntervalSeconds: Math.max(L.minIntervalSeconds, Math.min(600, Math.round(Number(body.intervalSeconds) || smsStoreSettings(owner.OwnerId).intervalSeconds))),
    ScheduledAt: body.scheduledAt ? smsCleanIso(body.scheduledAt) : '', UpdatedAt: nowIso()
  };
  if (body.scheduledAt && !fields.ScheduledAt) return fail('That date and time does not look right.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (body.campaignId) {
      var c = smsOwnerCampaign(owner, body.campaignId);
      if (!c) return fail('Campaign not found.');
      if (c.Status !== 'draft') return fail('Only a draft can be changed. Cancel this campaign and make a new one.');
      updateRowFromObject(smsCampaignsSheet(), c.__row, fields);
      return ok({ campaign: smsCampaignView(Object.assign({}, c, fields)) });
    }
    var row = Object.assign({ CampaignId: newId('smsc'), OwnerId: owner.OwnerId, Status: 'draft', CreatedAt: nowIso() }, fields);
    appendRowFromObject(smsCampaignsSheet(), row);
    return ok({ campaign: smsCampaignView(row) });
  } finally { lock.releaseLock(); }
}

function smsCleanIso(v) { var t = Date.parse(String(v)); return isNaN(t) ? '' : new Date(t).toISOString(); }

function actionSmsCampaignDelete(owner, body) {
  var c = smsOwnerCampaign(owner, body && body.campaignId);
  if (!c) return fail('Campaign not found.');
  if (c.Status !== 'draft') return fail('Only a draft can be deleted. Cancel a campaign instead.');
  smsCampaignsSheet().deleteRow(c.__row);
  return ok({ deleted: true });
}

/* ==================== approval ==================== */

/**
 * body: campaignId, confirmRecipients (the number the store was shown), requestId.
 * Starts (or schedules) a draft. Refused if the count changed since the store
 * looked, the phone is not connected, the SIM is not in it, the store is
 * suspended, or a limit would be passed.
 */
function actionSmsCampaignApprove(owner, body) {
  body = body || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var c = smsOwnerCampaign(owner, body.campaignId);
    if (!c) return fail('Campaign not found.');
    if (c.Status !== 'draft') {
      if (c.ApprovedAt) return ok({ campaign: smsCampaignView(c), replayed: true });
      return fail('This campaign is not a draft.');
    }
    var settings = smsStoreSettings(owner.OwnerId);
    if (settings.suspended) return fail('Sending is suspended for your store' + (settings.suspendedReason ? ': ' + settings.suspendedReason : '') + '. Contact Mwakete.');
    var device = smsOwnerDevice(owner, c.DeviceId);
    if (!device || device.Status !== 'active') return fail('Choose a connected phone to send from.');
    var sim = smsRows('SmsSims').filter(function (s) { return s.SimKey === c.SimKey && s.DeviceId === device.DeviceId; })[0];
    if (!sim) return fail('Choose the SIM to send from.');
    if (sim.Status !== 'present') return fail('That SIM is not in the phone right now. Put it back, or choose another SIM.');
    var spec = { kind: c.Kind, body: c.Body, groupIds: ctParse(c.GroupIdsJson, []), contactIds: ctParse(c.ContactIdsJson, []), excludeIds: ctParse(c.ExcludeIdsJson, []) };
    var r = smsResolveRecipients(owner, spec);
    if (!r.send.length) return fail('Nobody would get this message. Check who it goes to and their consent.');
    if (Number(body.confirmRecipients) !== r.send.length) {
      var changed = fail('The number of recipients changed (now ' + r.send.length + '). Check the campaign again before starting it.');
      changed.recipients = r.send.length;
      return changed;
    }
    if (r.send.length > settings.limits.maxCampaignRecipients) return fail('A campaign can go to at most ' + settings.limits.maxCampaignRecipients + ' people. Split it into smaller groups.');
    var now = nowIso();
    var mSheet = smsMessagesSheet();
    r.send.forEach(function (x) {
      appendRowFromObject(mSheet, { MessageId: newId('sms'), CampaignId: c.CampaignId, OwnerId: owner.OwnerId, ContactId: x.contact.ContactId, Phone: x.contact.Phone,
        Body: x.render.text, Segments: x.info.segments, Encoding: x.info.encoding, Status: 'queued', DeviceId: device.DeviceId, SimKey: c.SimKey, Attempts: 0,
        Error: '', ClaimedAt: '', SubmittedAt: '', SentAt: '', DeliveredAt: '', CreatedAt: now, UpdatedAt: now });
    });
    var suppressedCount = r.skipped.opted_out.length;
    var scheduled = c.ScheduledAt && String(c.ScheduledAt) > now;
    var fields = { Status: scheduled ? 'scheduled' : 'queued', Recipients: r.send.length, Suppressed: suppressedCount, Segments: r.segments, ApprovedAt: now, ApprovedBy: owner.OwnerId, UpdatedAt: now };
    updateRowFromObject(smsCampaignsSheet(), c.__row, fields);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_CAMPAIGN_APPROVED', entityType: 'sms_campaign', entityId: c.CampaignId,
      next: r.send.length + ' recipients, ' + r.segments + ' SMS, kind ' + c.Kind, requestId: body.requestId });
    return ok({ campaign: smsCampaignView(Object.assign({}, c, fields)) });
  } finally { lock.releaseLock(); }
}

/* ==================== pause / resume / cancel / retry ==================== */

function smsCampaignSetStatus(owner, campaignId, to, reason) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var c = smsOwnerCampaign(owner, campaignId);
    if (!c) return fail('Campaign not found.');
    var from = c.Status;
    var allowed = { paused: ['queued', 'processing', 'scheduled'], resumed: ['paused'], cancelled: ['queued', 'processing', 'scheduled', 'paused'] };
    if ((allowed[to] || []).indexOf(from) === -1) {
      if (from === to || (to === 'resumed' && (from === 'queued' || from === 'processing'))) return ok({ campaign: smsCampaignView(c) });
      return fail('This campaign is ' + (SMS_CAMPAIGN_STATUS_LABEL[from] || from).toLowerCase() + '.');
    }
    var next = to === 'resumed' ? (smsCampaignHasStarted(c) ? 'processing' : (c.ScheduledAt && String(c.ScheduledAt) > nowIso() ? 'scheduled' : 'queued')) : to;
    var fields = { Status: next, UpdatedAt: nowIso() };
    if (to === 'cancelled') {
      fields.CancelReason = ctText(reason, 300) || 'cancelled by the store';
      var mSheet = smsMessagesSheet();
      // Queued ones never go. Ones a phone already holds are cancelled too; the
      // phone is told at its next check-in. If it already sent one while
      // offline, its report still records that it was sent.
      smsObjects(mSheet).filter(function (m) { return m.CampaignId === c.CampaignId && (m.Status === 'queued' || m.Status === 'claimed'); }).forEach(function (m) {
        updateRowFromObject(mSheet, m.__row, { Status: 'cancelled', UpdatedAt: nowIso() });
      });
    }
    updateRowFromObject(smsCampaignsSheet(), c.__row, fields);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_CAMPAIGN_' + to.toUpperCase(), entityType: 'sms_campaign', entityId: c.CampaignId, reason: reason });
    if (to === 'cancelled') smsRefreshCampaigns(owner.OwnerId);
    return ok({ campaign: smsCampaignView(Object.assign({}, c, fields)) });
  } finally { lock.releaseLock(); }
}

function smsCampaignHasStarted(c) { return !!c.StartedAt; }

function actionSmsCampaignPause(owner, body) { return smsCampaignSetStatus(owner, body && body.campaignId, 'paused'); }
function actionSmsCampaignResume(owner, body) { return smsCampaignSetStatus(owner, body && body.campaignId, 'resumed'); }
function actionSmsCampaignCancel(owner, body) { return smsCampaignSetStatus(owner, body && body.campaignId, 'cancelled', body && body.reason); }

// Failures worth another go. A number the network rejected outright is not.
var SMS_RETRYABLE_ERRORS = ['generic_failure', 'no_service', 'radio_off', 'null_pdu', 'limit_exceeded', 'no_report', 'phone_removed', 'sim_missing', 'failed', 'timeout'];

/** body: campaignId. Failed (retryable) and expired messages go back in the queue - at most 3 tries each - re-checked against opt-outs. */
function actionSmsCampaignRetry(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var c = smsOwnerCampaign(owner, body && body.campaignId);
    if (!c) return fail('Campaign not found.');
    if (c.Status === 'cancelled' || c.Status === 'draft') return fail('This campaign is ' + SMS_CAMPAIGN_STATUS_LABEL[c.Status].toLowerCase() + '.');
    var suppressed = ownerSuppressed(owner);
    var contacts = {};
    ownerContactRows(owner).forEach(function (x) { contacts[x.ContactId] = x; });
    var mSheet = smsMessagesSheet();
    var n = 0, skipped = 0;
    smsObjects(mSheet).filter(function (m) { return m.CampaignId === c.CampaignId && (m.Status === 'failed' || m.Status === 'expired'); }).forEach(function (m) {
      var contact = contacts[m.ContactId];
      var retryable = m.Status === 'expired' || SMS_RETRYABLE_ERRORS.indexOf(String(m.Error)) !== -1;
      if (!retryable || (Number(m.Attempts) || 0) >= 3 || !contact || !contactMaySend(contact, c.Kind, suppressed).ok) { skipped++; return; }
      var device = smsOwnerDevice(owner, c.DeviceId);
      updateRowFromObject(mSheet, m.__row, { Status: 'queued', Error: '', ClaimedAt: '', DeviceId: device && device.Status === 'active' ? device.DeviceId : m.DeviceId, UpdatedAt: nowIso() });
      n++;
    });
    if (n) updateRowFromObject(smsCampaignsSheet(), c.__row, { Status: c.StartedAt ? 'processing' : 'queued', CompletedAt: '', UpdatedAt: nowIso() });
    return ok({ requeued: n, skipped: skipped });
  } finally { lock.releaseLock(); }
}

/** Recounts each live campaign of a store and marks it completed when nothing is left to send. Lock held by the caller. */
function smsRefreshCampaigns(ownerId) {
  var msgs = smsRows('SmsMessages').filter(function (m) { return m.OwnerId === ownerId; });
  var by = {};
  msgs.forEach(function (m) { var t = by[m.CampaignId] = by[m.CampaignId] || {}; t[m.Status] = (t[m.Status] || 0) + 1; });
  var sheet = smsCampaignsSheet();
  smsObjects(sheet).filter(function (c) { return c.OwnerId === ownerId && c.Status !== 'draft'; }).forEach(function (c) {
    var t = by[c.CampaignId] || {};
    var fields = { Totals: JSON.stringify(t) };
    var open = (t.queued || 0) + (t.claimed || 0);
    if (open === 0 && (c.Status === 'processing' || c.Status === 'queued')) { fields.Status = 'completed'; fields.CompletedAt = nowIso(); }
    if (fields.Totals !== c.Totals || fields.Status) updateRowFromObject(sheet, c.__row, Object.assign(fields, { UpdatedAt: nowIso() }));
  });
}

/* ==================== reading ==================== */

function actionSmsCampaigns(owner) {
  var list = smsRows('SmsCampaigns').filter(function (c) { return c.OwnerId === owner.OwnerId; }).map(smsCampaignView);
  list.sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? 1 : -1; });
  return ok({ campaigns: list });
}

/** body: campaignId, status?, offset, limit. A campaign and its recipients' results. */
function actionSmsCampaignGet(owner, body) {
  var c = smsOwnerCampaign(owner, body && body.campaignId);
  if (!c) return fail('Campaign not found.');
  var names = {};
  ownerContactRows(owner, true).forEach(function (x) { names[x.ContactId] = contactDisplayName(x); });
  var msgs = smsRows('SmsMessages').filter(function (m) { return m.CampaignId === c.CampaignId && (!body.status || m.Status === body.status); });
  var offset = Math.max(0, Number(body.offset) || 0), limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
  return ok({ campaign: smsCampaignView(c), total: msgs.length, messages: msgs.slice(offset, offset + limit).map(function (m) {
    return { messageId: m.MessageId, name: names[m.ContactId] || '', phone: m.Phone, body: m.Body, segments: Number(m.Segments) || 1, status: m.Status,
      statusLabel: SMS_MESSAGE_STATUS_LABEL[m.Status] || m.Status, error: m.Error || '', attempts: Number(m.Attempts) || 0,
      submittedAt: m.SubmittedAt || '', sentAt: m.SentAt || '', deliveredAt: m.DeliveredAt || '' };
  }) });
}

/** A campaign's results as CSV. */
function actionSmsCampaignExport(owner, body) {
  var res = actionSmsCampaignGet(owner, { campaignId: body && body.campaignId, offset: 0, limit: 500 });
  if (!res.ok) return res;
  var rows = res.messages;
  for (var off = 500; off < res.total; off += 500) rows = rows.concat(actionSmsCampaignGet(owner, { campaignId: body.campaignId, offset: off, limit: 500 }).messages);
  var head = ['Name', 'Phone', 'Status', 'Error', 'SMS segments', 'Submitted', 'Accepted by network', 'Delivered', 'Message'];
  var lines = [head.map(csvCell).join(',')].concat(rows.map(function (m) {
    return [m.name, m.phone, m.statusLabel, m.error, m.segments, m.submittedAt, m.sentAt, m.deliveredAt, m.body].map(csvCell).join(',');
  }));
  return ok({ csv: lines.join('\n'), count: rows.length });
}

/* ==================== routing ==================== */

/**
 * Every Contacts & SMS action a signed-in store (or its Sheets add-on key) may
 * call, and who may call it. 'key' = the Sheets add-on may use it (never
 * approve, devices, keys or settings - those need the store's own sign-in).
 * 'admin' = Mwakete admins only.
 */
var SMS_ACTIONS = {
  smsDashboard: { fn: 'actionSmsDashboard', key: true },
  contactsList: { fn: 'actionContactsList', key: true }, contactGet: { fn: 'actionContactGet', key: true }, contactSave: { fn: 'actionContactSave', key: true },
  contactDelete: { fn: 'actionContactDelete' }, contactSetConsent: { fn: 'actionContactSetConsent' }, contactConsentHistory: { fn: 'actionContactConsentHistory' },
  contactsDuplicates: { fn: 'actionContactsDuplicates', key: true }, contactsMerge: { fn: 'actionContactsMerge' },
  contactsImportPreview: { fn: 'actionContactsImportPreview', key: true }, contactsImportApply: { fn: 'actionContactsImportApply', key: true },
  contactsFromOrders: { fn: 'actionContactsFromOrders' }, contactsExport: { fn: 'actionContactsExport', key: true }, contactsChanges: { fn: 'actionContactsChanges', key: true },
  contactCategories: { fn: 'actionContactCategories', key: true }, contactCategoryAdd: { fn: 'actionContactCategoryAdd' },
  contactGroups: { fn: 'actionContactGroups', key: true }, contactGroupSave: { fn: 'actionContactGroupSave', key: true }, contactGroupDelete: { fn: 'actionContactGroupDelete' },
  contactGroupMembers: { fn: 'actionContactGroupMembers', key: true },
  smsSuppressionList: { fn: 'actionSmsSuppressionList' },
  smsTemplates: { fn: 'actionSmsTemplates', key: true }, smsTemplateSave: { fn: 'actionSmsTemplateSave' }, smsTemplateDelete: { fn: 'actionSmsTemplateDelete' },
  smsCampaignEstimate: { fn: 'actionSmsCampaignEstimate', key: true }, smsCampaignSave: { fn: 'actionSmsCampaignSave', key: true },
  smsCampaignDelete: { fn: 'actionSmsCampaignDelete' }, smsCampaignApprove: { fn: 'actionSmsCampaignApprove' },
  smsCampaignPause: { fn: 'actionSmsCampaignPause' }, smsCampaignResume: { fn: 'actionSmsCampaignResume' }, smsCampaignCancel: { fn: 'actionSmsCampaignCancel' },
  smsCampaignRetry: { fn: 'actionSmsCampaignRetry' }, smsCampaigns: { fn: 'actionSmsCampaigns', key: true }, smsCampaignGet: { fn: 'actionSmsCampaignGet', key: true },
  smsCampaignExport: { fn: 'actionSmsCampaignExport', key: true },
  smsDevices: { fn: 'actionSmsDevices' }, smsPairStart: { fn: 'actionSmsPairStart' }, smsDeviceRename: { fn: 'actionSmsDeviceRename' }, smsDeviceRevoke: { fn: 'actionSmsDeviceRevoke' },
  smsSimUpdate: { fn: 'actionSmsSimUpdate' }, smsUsage: { fn: 'actionSmsUsage', key: true },
  smsSettingsGet: { fn: 'actionSmsSettingsGet' }, smsSettingsSave: { fn: 'actionSmsSettingsSave' },
  smsApiKeyCreate: { fn: 'actionSmsApiKeyCreate' }, smsApiKeys: { fn: 'actionSmsApiKeys' }, smsApiKeyRevoke: { fn: 'actionSmsApiKeyRevoke' },
  adminSmsOverview: { fn: 'actionAdminSmsOverview', admin: true }, adminSmsSuspend: { fn: 'actionAdminSmsSuspend', admin: true },
  adminSmsViewContacts: { fn: 'actionAdminSmsViewContacts', admin: true }, adminSmsCancelCampaign: { fn: 'actionAdminSmsCancelCampaign', admin: true },
  adminSmsLimits: { fn: 'actionAdminSmsLimits', admin: true }, adminSmsDevices: { fn: 'actionAdminSmsDevices', admin: true }, adminGeoSave: { fn: 'actionAdminGeoSave', admin: true }
};

/** Called from doPost for any action in SMS_ACTIONS. body.token (the store's sign-in) or body.apiKey (the Sheets add-on). */
function dispatchSmsAction(action, body) {
  var def = SMS_ACTIONS[action];
  if (!contactsSmsEnabled()) return smsOff();
  var owner, viaKey = false;
  if (body.apiKey) {
    owner = smsOwnerFromApiKey(body.apiKey);
    if (!owner) { var bad = fail('That add-on key is not valid. Make a new one on Mwakete.com.'); bad.errorKind = 'auth'; return bad; }
    viaKey = true;
    if (!def.key) return fail('Do this on Mwakete.com.');
    if (rateLimitHit('smskey:' + owner.OwnerId, 600, 3600)) return fail('Too many requests from the add-on - try again later.');
  } else {
    try { owner = requireAuth(body.token); } catch (e) { var r = fail(e.message || 'Not authenticated'); r.errorKind = 'auth'; return r; }
  }
  if (def.admin && (viaKey || !isOwnerAdmin(owner))) return fail('Not authorized');
  if (String(owner.Status || 'active') !== 'active' && !def.admin) return fail('Your store is not active.');
  return globalThis[def.fn](owner, body);
}
