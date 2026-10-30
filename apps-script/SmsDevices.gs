/**
 * Mwakete Contacts & SMS - phones, SIMs, the sending queue, limits, usage,
 * admin tools and Sheets add-on keys (Oct 2026, docs/contacts-sms-architecture.md).
 *
 * PHONES. A store links an Android phone with a one-time code (10 minutes)
 * shown on Mwakete.com; the app answers it with smsPairDevice and gets a
 * device id and secret (answered once, stored hashed - the same pattern as
 * the POS tills). Every later call carries both. A removed phone's secret
 * stops working at once. The app rotates its secret every 30 days.
 *
 * SENDING. Messages are sent by the phone, from the SIM the store chose, with
 * the phone's own SMS allowance. Nothing goes through a paid gateway. The
 * phone checks in (smsDeviceSync): it reports results for messages it has,
 * learns which campaigns were paused or cancelled, and takes the next small
 * batch of queued messages (it can then send them with no internet). A
 * message is "delivered" only when the network sent a delivery report back.
 *
 * LIMITS (Script Property SMS_LIMITS, JSON, admin-editable) and quiet hours
 * apply on the server and again on the phone. Nothing here tries to get
 * round a carrier's limits.
 */

var SMS_DEVICE_HEADERS = ['DeviceId', 'OwnerId', 'Name', 'SecretHash', 'Status', 'Model', 'AppVersion', 'AndroidVersion', 'CreatedAt', 'LastSeenAt',
  'SecretRotatedAt', 'RevokedAt', 'RevokedBy'];
var SMS_PAIR_HEADERS = ['CodeHash', 'OwnerId', 'Name', 'ExpiresAt', 'UsedAt', 'CreatedAt'];
var SMS_SIM_HEADERS = ['SimKey', 'DeviceId', 'OwnerId', 'SubscriptionId', 'SlotIndex', 'CarrierName', 'DisplayName', 'NumberHint', 'Status',
  'IsDefault', 'AllowanceSegments', 'AllowanceResetDay', 'FirstSeenAt', 'LastSeenAt'];
var SMS_STORE_HEADERS = ['OwnerId', 'Suspended', 'SuspendedReason', 'QuietStart', 'QuietEnd', 'UtcOffset', 'IntervalSeconds', 'DailyLimit', 'UpdatedAt'];
var SMS_APIKEY_HEADERS = ['KeyId', 'OwnerId', 'KeyHash', 'Label', 'Status', 'CreatedAt', 'LastUsedAt', 'RevokedAt'];

var SMS_DEFAULT_LIMITS = {
  maxContactsPerStore: 10000,
  maxCampaignRecipients: 1000,     // one campaign
  maxDailyPerDevice: 500,          // messages a phone may send in a day
  maxDailyPerStore: 1500,          // messages a store may send in a day, all phones
  minIntervalSeconds: 3,           // the fastest a phone may send, one message every N seconds
  defaultIntervalSeconds: 8,
  batchSize: 50,                   // messages a phone takes at a time
  claimHours: 48,                  // a taken message not reported in this long expires
  maxDevicesPerStore: 5,
  quietStart: 21, quietEnd: 7,     // no sending between these local hours
  utcOffset: 12                    // Tarawa
};

function smsLimits() {
  var raw = PropertiesService.getScriptProperties().getProperty('SMS_LIMITS');
  var set = {};
  try { set = JSON.parse(raw || '{}') || {}; } catch (e) { set = {}; }
  var out = {};
  Object.keys(SMS_DEFAULT_LIMITS).forEach(function (k) { out[k] = set[k] !== undefined && isFinite(Number(set[k])) ? Number(set[k]) : SMS_DEFAULT_LIMITS[k]; });
  return out;
}

function smsDevicesSheet() { return hubSheet('SmsDevices', SMS_DEVICE_HEADERS); }
function smsPairSheet() { return hubSheet('SmsPairCodes', SMS_PAIR_HEADERS); }
function smsSimsSheet() { return hubSheet('SmsSims', SMS_SIM_HEADERS); }
function smsStoreSheet() { return hubSheet('SmsStoreSettings', SMS_STORE_HEADERS); }
function smsApiKeySheet() { return hubSheet('SmsApiKeys', SMS_APIKEY_HEADERS); }

/* ==================== store settings ==================== */

function smsStoreRow(ownerId) { return smsRows('SmsStoreSettings').filter(function (s) { return s.OwnerId === ownerId; })[0] || null; }

/** This store's effective settings: its own choices inside the admin limits. */
function smsStoreSettings(ownerId) {
  var L = smsLimits();
  var s = smsStoreRow(ownerId) || {};
  var num = function (v, d) { return v === '' || v == null || !isFinite(Number(v)) ? d : Number(v); };
  return {
    suspended: String(s.Suspended) === 'yes', suspendedReason: s.SuspendedReason || '',
    quietStart: num(s.QuietStart, L.quietStart), quietEnd: num(s.QuietEnd, L.quietEnd), utcOffset: num(s.UtcOffset, L.utcOffset),
    intervalSeconds: Math.max(L.minIntervalSeconds, num(s.IntervalSeconds, L.defaultIntervalSeconds)),
    dailyLimit: Math.min(L.maxDailyPerStore, num(s.DailyLimit, L.maxDailyPerStore)),
    limits: L
  };
}

function smsLocalHour(utcOffset, now) {
  var d = now || new Date();
  return (d.getUTCHours() + Math.round(utcOffset) + 48) % 24;
}
function smsInQuietHours(settings, now) {
  var h = smsLocalHour(settings.utcOffset, now);
  var a = settings.quietStart, b = settings.quietEnd;
  if (a === b) return false;
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

function actionSmsSettingsGet(owner) { return ok({ settings: smsStoreSettings(owner.OwnerId) }); }

/** body: quietStart, quietEnd, intervalSeconds, dailyLimit. Clamped to the admin limits. */
function actionSmsSettingsSave(owner, body) {
  var L = smsLimits();
  var hour = function (v) { var n = Math.round(Number(v)); return n >= 0 && n <= 23 ? n : null; };
  var fields = { UpdatedAt: nowIso() };
  if (body.quietStart !== undefined) { if (hour(body.quietStart) === null) return fail('Quiet hours are 0 to 23.'); fields.QuietStart = hour(body.quietStart); }
  if (body.quietEnd !== undefined) { if (hour(body.quietEnd) === null) return fail('Quiet hours are 0 to 23.'); fields.QuietEnd = hour(body.quietEnd); }
  if (body.intervalSeconds !== undefined) fields.IntervalSeconds = Math.max(L.minIntervalSeconds, Math.min(600, Math.round(Number(body.intervalSeconds) || L.defaultIntervalSeconds)));
  if (body.dailyLimit !== undefined) fields.DailyLimit = Math.max(1, Math.min(L.maxDailyPerStore, Math.round(Number(body.dailyLimit) || L.maxDailyPerStore)));
  var row = smsStoreRow(owner.OwnerId);
  if (row) updateRowFromObject(smsStoreSheet(), row.__row, fields);
  else appendRowFromObject(smsStoreSheet(), Object.assign({ OwnerId: owner.OwnerId, Suspended: '' }, fields));
  return ok({ settings: smsStoreSettings(owner.OwnerId) });
}

/* ==================== pairing & device sign-in ==================== */

function smsPairCodeNew() {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
  var out = '';
  var bytes = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < 8; i++) out += alphabet.charAt(parseInt(bytes.substr(i * 2, 2), 16) % alphabet.length);
  return out;
}

/** body: name. A one-time code (10 minutes) to type into the Mwakete SMS app. */
function actionSmsPairStart(owner, body) {
  var name = ctText(body && body.name, 40) || 'My phone';
  var L = smsLimits();
  var active = smsRows('SmsDevices').filter(function (d) { return d.OwnerId === owner.OwnerId && d.Status === 'active'; }).length;
  if (active >= L.maxDevicesPerStore) return fail('You have ' + active + ' phones connected (the most is ' + L.maxDevicesPerStore + '). Remove one first.');
  if (rateLimitHit('smspair:' + owner.OwnerId, 10, 3600)) return fail('Too many codes - try again in a while.');
  var code = smsPairCodeNew();
  var expires = new Date(Date.now() + 10 * 60000).toISOString();
  appendRowFromObject(smsPairSheet(), { CodeHash: hashSecretToken(code), OwnerId: owner.OwnerId, Name: name, ExpiresAt: expires, UsedAt: '', CreatedAt: nowIso() });
  return ok({ code: code.slice(0, 4) + '-' + code.slice(4), expiresAt: expires });
}

/**
 * Public - the app, with the code. body: code, model, appVersion, androidVersion.
 * Answers deviceId + deviceSecret once.
 */
function actionSmsPairDevice(body) {
  if (!contactsSmsEnabled()) return smsOff();
  var code = String((body && body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) return fail('Type the 8-character code shown on Mwakete.com.');
  if (rateLimitHit('smspairtry:all', 300, 3600)) return fail('Please try again later.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = smsPairSheet();
    var h = hashSecretToken(code);
    var row = smsObjects(sheet).filter(function (r) { return constantTimeEquals(String(r.CodeHash), h); })[0];
    if (!row || row.UsedAt || String(row.ExpiresAt) < nowIso()) return fail('That code is not valid or has expired. Make a new one on Mwakete.com.');
    var owner = smsRows('Owners').filter(function (o) { return o.OwnerId === row.OwnerId; })[0];
    if (!owner) return fail('That code is not valid or has expired. Make a new one on Mwakete.com.');
    updateRowFromObject(sheet, row.__row, { UsedAt: nowIso() });
    var deviceId = newId('smsdev');
    var secret = generateToken();
    appendRowFromObject(smsDevicesSheet(), { DeviceId: deviceId, OwnerId: owner.OwnerId, Name: row.Name, SecretHash: hashSecretToken(secret), Status: 'active',
      Model: ctText(body.model, 80), AppVersion: ctText(body.appVersion, 20), AndroidVersion: ctText(body.androidVersion, 20), CreatedAt: nowIso(), LastSeenAt: nowIso(),
      SecretRotatedAt: nowIso(), RevokedAt: '', RevokedBy: '' });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_DEVICE_PAIRED', entityType: 'sms_device', entityId: deviceId, next: row.Name + ' / ' + ctText(body.model, 80) });
    return ok({ deviceId: deviceId, deviceSecret: secret, name: row.Name, storeName: owner.StoreName || '', settings: smsDeviceSettingsView(owner.OwnerId) });
  } finally { lock.releaseLock(); }
}

/** The device row for a valid id + secret, or null. Never trusts a phone number. */
function smsCheckDevice(deviceId, secret) {
  var id = String(deviceId || '');
  if (!id || !secret) return null;
  var d = smsRows('SmsDevices').filter(function (x) { return x.DeviceId === id; })[0];
  if (!d || d.Status !== 'active') return null;
  if (!constantTimeEquals(String(d.SecretHash), hashSecretToken(String(secret)))) return null;
  return d;
}

function smsDeviceSettingsView(ownerId) {
  var s = smsStoreSettings(ownerId);
  return { quietStart: s.quietStart, quietEnd: s.quietEnd, utcOffset: s.utcOffset, intervalSeconds: s.intervalSeconds,
    dailyLimit: Math.min(s.dailyLimit, s.limits.maxDailyPerDevice), batchSize: s.limits.batchSize, suspended: s.suspended, maxSegments: SMS_MAX_SEGMENTS };
}

/** Public - the app. body: deviceId, deviceSecret. A new secret; the old one stops working. */
function actionSmsDeviceRotate(body) {
  if (!contactsSmsEnabled()) return smsOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var d = smsCheckDevice(body && body.deviceId, body && body.deviceSecret);
    if (!d) return smsDeviceDenied();
    var secret = generateToken();
    updateRowFromObject(smsDevicesSheet(), d.__row, { SecretHash: hashSecretToken(secret), SecretRotatedAt: nowIso() });
    return ok({ deviceSecret: secret });
  } finally { lock.releaseLock(); }
}

function smsDeviceDenied() { var r = fail('This phone is no longer connected to your store. Connect it again on Mwakete.com.'); r.errorKind = 'device_revoked'; return r; }

/* ==================== SIMs ==================== */

function smsSimKey(deviceId, sim) {
  var subId = String(sim.subscriptionId == null ? '' : sim.subscriptionId);
  var icc = ctText(sim.iccHash, 80);
  return deviceId + ':' + (icc || ('sub' + subId));
}

/**
 * Updates the SIMs a phone reports (subscription id, slot, carrier, last digits
 * of the number when Android shares them, a hash of the SIM id - never the
 * full SIM id). A SIM the phone no longer has is marked 'missing'; campaigns
 * on it stop being handed out - nothing switches to another SIM.
 */
function smsUpdateSims(d, sims) {
  if (!Array.isArray(sims)) return;
  var sheet = smsSimsSheet();
  var rows = smsObjects(sheet).filter(function (s) { return s.DeviceId === d.DeviceId; });
  var seen = {};
  sims.slice(0, 4).forEach(function (sim) {
    var key = smsSimKey(d.DeviceId, sim);
    seen[key] = true;
    var fields = { SubscriptionId: String(sim.subscriptionId == null ? '' : sim.subscriptionId), SlotIndex: Number(sim.slotIndex) || 0, CarrierName: ctText(sim.carrierName, 40),
      DisplayName: ctText(sim.displayName, 40), NumberHint: ctText(sim.numberHint, 4).replace(/\D/g, ''), Status: 'present', LastSeenAt: nowIso() };
    var row = rows.filter(function (r) { return r.SimKey === key; })[0];
    if (row) updateRowFromObject(sheet, row.__row, fields);
    else appendRowFromObject(sheet, Object.assign({ SimKey: key, DeviceId: d.DeviceId, OwnerId: d.OwnerId, IsDefault: rows.length ? '' : 'yes', AllowanceSegments: '', AllowanceResetDay: '', FirstSeenAt: nowIso() }, fields));
  });
  rows.forEach(function (r) { if (!seen[r.SimKey] && r.Status !== 'missing') updateRowFromObject(sheet, r.__row, { Status: 'missing' }); });
}

function smsSimView(s) {
  return { simKey: s.SimKey, deviceId: s.DeviceId, subscriptionId: s.SubscriptionId, slot: Number(s.SlotIndex) + 1, carrier: s.CarrierName || '', name: s.DisplayName || '',
    numberHint: s.NumberHint || '', status: s.Status, isDefault: s.IsDefault === 'yes',
    allowance: s.AllowanceSegments === '' || s.AllowanceSegments == null ? null : Number(s.AllowanceSegments), resetDay: s.AllowanceResetDay === '' ? null : Number(s.AllowanceResetDay), lastSeenAt: s.LastSeenAt };
}

/* ==================== devices (store side) ==================== */

function actionSmsDevices(owner) {
  var sims = smsRows('SmsSims').filter(function (s) { return s.OwnerId === owner.OwnerId; });
  return ok({ devices: smsRows('SmsDevices').filter(function (d) { return d.OwnerId === owner.OwnerId; }).map(function (d) {
    return { deviceId: d.DeviceId, name: d.Name, status: d.Status, model: d.Model, appVersion: d.AppVersion, androidVersion: d.AndroidVersion,
      createdAt: d.CreatedAt, lastSeenAt: d.LastSeenAt, revokedAt: d.RevokedAt || '',
      sims: sims.filter(function (s) { return s.DeviceId === d.DeviceId; }).map(smsSimView) };
  }), settings: smsStoreSettings(owner.OwnerId) });
}

function smsOwnerDevice(owner, deviceId) { return smsRows('SmsDevices').filter(function (d) { return d.OwnerId === owner.OwnerId && d.DeviceId === String(deviceId || ''); })[0] || null; }

function actionSmsDeviceRename(owner, body) {
  var d = smsOwnerDevice(owner, body && body.deviceId);
  if (!d) return fail('Phone not found.');
  var name = ctText(body.name, 40);
  if (name.length < 2) return fail('Give the phone a name.');
  updateRowFromObject(smsDevicesSheet(), d.__row, { Name: name });
  return ok({ saved: true });
}

/**
 * Removes a phone. Its secret stops working at once. Messages it had taken but
 * not reported become 'expired' (the store can retry them on another phone) -
 * they are not handed to another phone automatically, because the removed
 * phone may already have sent them while offline.
 */
function actionSmsDeviceRevoke(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var d = smsOwnerDevice(owner, body && body.deviceId);
    if (!d) return fail('Phone not found.');
    if (d.Status === 'revoked') return ok({ revoked: true });
    updateRowFromObject(smsDevicesSheet(), d.__row, { Status: 'revoked', RevokedAt: nowIso(), RevokedBy: owner.OwnerId, SecretHash: '' });
    var mSheet = smsMessagesSheet();
    var n = 0;
    smsObjects(mSheet).filter(function (m) { return m.DeviceId === d.DeviceId && m.Status === 'claimed'; }).forEach(function (m) {
      updateRowFromObject(mSheet, m.__row, { Status: 'expired', Error: 'phone_removed', UpdatedAt: nowIso() });
      n++;
    });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_DEVICE_REVOKED', entityType: 'sms_device', entityId: d.DeviceId, next: n + ' messages expired' });
    smsRefreshCampaigns(owner.OwnerId);
    return ok({ revoked: true, expired: n });
  } finally { lock.releaseLock(); }
}

/** body: simKey, name?, isDefault?, allowance? (segments or ''), resetDay? (1-31 or ''). */
function actionSmsSimUpdate(owner, body) {
  var sheet = smsSimsSheet();
  var rows = smsObjects(sheet).filter(function (s) { return s.OwnerId === owner.OwnerId; });
  var sim = rows.filter(function (s) { return s.SimKey === String((body && body.simKey) || ''); })[0];
  if (!sim) return fail('SIM not found.');
  var fields = {};
  if (body.name !== undefined) fields.DisplayName = ctText(body.name, 40);
  if (body.allowance !== undefined) {
    if (body.allowance === '' || body.allowance === null) fields.AllowanceSegments = '';
    else { var a = Math.round(Number(body.allowance)); if (!(a >= 0 && a <= 100000)) return fail('Allowance is a number of SMS, 0 to 100,000.'); fields.AllowanceSegments = a; }
  }
  if (body.resetDay !== undefined) {
    if (body.resetDay === '' || body.resetDay === null) fields.AllowanceResetDay = '';
    else { var r = Math.round(Number(body.resetDay)); if (!(r >= 1 && r <= 31)) return fail('Reset day is 1 to 31.'); fields.AllowanceResetDay = r; }
  }
  if (body.isDefault) {
    rows.filter(function (s) { return s.DeviceId === sim.DeviceId && s.IsDefault === 'yes' && s.SimKey !== sim.SimKey; }).forEach(function (s) { updateRowFromObject(sheet, s.__row, { IsDefault: '' }); });
    fields.IsDefault = 'yes';
  }
  updateRowFromObject(sheet, sim.__row, fields);
  return ok({ sim: smsSimView(Object.assign({}, sim, fields)) });
}

/* ==================== the phone's check-in ==================== */

/**
 * Public - the app. body: deviceId, deviceSecret, appVersion, androidVersion,
 * sims [...], results [{ messageId, status submitted|sent|delivered|failed,
 * error, at, simKey }], inbound [{ from, text, at }], take (how many new
 * messages it can take now; 0 when it only reports).
 *
 * Answers: settings, stop [messageIds the phone must not send - paused or
 * cancelled], messages [new batch], and serverTime.
 */
function actionSmsDeviceSync(body) {
  if (!contactsSmsEnabled()) return smsOff();
  body = body || {};
  if (rateLimitHit('smssync:' + String(body.deviceId || ''), 240, 3600)) return fail('Too many check-ins - slowing down.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var d = smsCheckDevice(body.deviceId, body.deviceSecret);
    if (!d) return smsDeviceDenied();
    var now = new Date();
    updateRowFromObject(smsDevicesSheet(), d.__row, { LastSeenAt: now.toISOString(), AppVersion: ctText(body.appVersion, 20) || d.AppVersion, AndroidVersion: ctText(body.androidVersion, 20) || d.AndroidVersion });
    smsUpdateSims(d, body.sims);
    var reported = smsApplyResults(d, body.results);
    var inbound = smsApplyInbound(d, body.inbound);
    var settings = smsStoreSettings(d.OwnerId);
    var mSheet = smsMessagesSheet();
    var all = smsObjects(mSheet);
    var campaigns = {};
    smsRows('SmsCampaigns').filter(function (c) { return c.OwnerId === d.OwnerId; }).forEach(function (c) { campaigns[c.CampaignId] = c; });
    var mine = all.filter(function (m) { return m.DeviceId === d.DeviceId; });
    // Messages this phone holds whose campaign is no longer sending.
    var stop = mine.filter(function (m) {
      var c = campaigns[m.CampaignId];
      return m.Status === 'claimed' && (!c || c.Status === 'paused' || c.Status === 'cancelled' || settings.suspended);
    }).map(function (m) { return m.MessageId; });
    var batch = [];
    var take = Math.max(0, Math.min(settings.limits.batchSize, Math.round(Number(body.take) || 0)));
    if (take && !settings.suspended && !smsInQuietHours(settings, now)) {
      var dayStart = smsLocalDayStartIso(settings.utcOffset, now);
      var todayDevice = mine.filter(function (m) { return smsCountsAsSent(m) && String(m.ClaimedAt) >= dayStart; }).length;
      var todayStore = all.filter(function (m) { return m.OwnerId === d.OwnerId && smsCountsAsSent(m) && String(m.ClaimedAt) >= dayStart; }).length;
      var room = Math.min(take, settings.limits.maxDailyPerDevice - todayDevice, settings.dailyLimit - todayStore);
      var presentSims = {};
      smsRows('SmsSims').filter(function (s) { return s.DeviceId === d.DeviceId && s.Status === 'present'; }).forEach(function (s) { presentSims[s.SimKey] = s; });
      var nowIsoStr = now.toISOString();
      all.forEach(function (m) {
        if (batch.length >= room || m.Status !== 'queued' || m.OwnerId !== d.OwnerId) return;
        var c = campaigns[m.CampaignId];
        // 'scheduled' waits for its time (next line), then starts like 'queued'.
        if (!c || c.DeviceId !== d.DeviceId || ['queued', 'processing', 'scheduled'].indexOf(c.Status) === -1) return;
        if (c.ScheduledAt && String(c.ScheduledAt) > nowIsoStr) return;
        if (!presentSims[c.SimKey]) return;   // the chosen SIM is not in the phone: wait, never switch
        updateRowFromObject(mSheet, m.__row, { Status: 'claimed', ClaimedAt: nowIsoStr, Attempts: (Number(m.Attempts) || 0) + 1, UpdatedAt: nowIsoStr });
        if (c.Status === 'queued' || c.Status === 'scheduled') { updateRowFromObject(smsCampaignsSheet(), c.__row, { Status: 'processing', StartedAt: nowIsoStr, UpdatedAt: nowIsoStr }); c.Status = 'processing'; }
        batch.push({ messageId: m.MessageId, campaignId: m.CampaignId, to: m.Phone, body: m.Body, segments: Number(m.Segments) || 1,
          simKey: c.SimKey, subscriptionId: presentSims[c.SimKey].SubscriptionId, intervalSeconds: Math.max(settings.limits.minIntervalSeconds, Number(c.IntervalSeconds) || settings.intervalSeconds) });
      });
    }
    smsExpireStale(all, mSheet, settings.limits.claimHours, d.OwnerId);
    if (reported || batch.length) smsRefreshCampaigns(d.OwnerId);
    return ok({ settings: smsDeviceSettingsView(d.OwnerId), stop: stop, messages: batch, accepted: reported, inbound: inbound,
      quiet: smsInQuietHours(settings, now), serverTime: now.toISOString(), rotateSecret: smsRotationDue(d) });
  } finally { lock.releaseLock(); }
}

function smsCountsAsSent(m) { return ['claimed', 'submitted', 'sent', 'delivered', 'failed'].indexOf(m.Status) !== -1 && m.ClaimedAt; }

function smsLocalDayStartIso(utcOffset, now) {
  var localMs = now.getTime() + utcOffset * 3600000;
  var local = new Date(localMs);
  var startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(startLocal - utcOffset * 3600000).toISOString();
}

function smsRotationDue(d) {
  var at = Date.parse(d.SecretRotatedAt || d.CreatedAt || '');
  return !at || Date.now() - at > 30 * 86400000;
}

/**
 * Results from the phone. Only messages this phone took; a status only moves
 * forward (SMS_STATUS_RANK), so a repeated or late report changes nothing.
 * Answers how many were applied.
 */
function smsApplyResults(d, results) {
  if (!Array.isArray(results) || !results.length) return 0;
  var sheet = smsMessagesSheet();
  var byId = {};
  smsObjects(sheet).forEach(function (m) { if (m.DeviceId === d.DeviceId) byId[m.MessageId] = m; });
  var n = 0;
  results.slice(0, 500).forEach(function (r) {
    var m = byId[String(r && r.messageId)];
    var to = String((r && r.status) || '');
    if (!m || ['submitted', 'sent', 'delivered', 'failed'].indexOf(to) === -1) return;
    if ((SMS_STATUS_RANK[to] || 0) <= (SMS_STATUS_RANK[m.Status] || 0) && !(m.Status === 'failed' && to === 'delivered')) return;
    if (m.Status === 'cancelled' || m.Status === 'expired') {
      // The phone sent it before it heard about the cancel (offline). Record the truth.
      if (to === 'failed') return;
    }
    var at = /^\d{4}-\d\d-\d\dT/.test(String(r.at || '')) ? String(r.at) : nowIso();
    var f = { Status: to, UpdatedAt: nowIso() };
    if (to === 'submitted') f.SubmittedAt = at;
    if (to === 'sent') { f.SentAt = at; if (!m.SubmittedAt) f.SubmittedAt = at; }
    if (to === 'delivered') { f.DeliveredAt = at; if (!m.SentAt) f.SentAt = at; }
    if (to === 'failed') f.Error = ctText(r.error, 60) || 'failed';
    if (r.simKey && r.simKey !== m.SimKey) f.Error = 'sent_from_other_sim';
    updateRowFromObject(sheet, m.__row, f);
    m.Status = to;
    n++;
  });
  return n;
}

/**
 * Texts the phone received in reply. STOP / UNSUBSCRIBE / STOP ALL (any case,
 * on its own) from a number puts it on this store's suppression list for
 * promotions and announcements. Nothing else is stored - the app does not
 * upload anyone's private messages.
 */
var SMS_STOP_WORDS = ['stop', 'unsubscribe', 'stop all', 'stopall', 'cancel', 'end', 'quit'];
function smsApplyInbound(d, inbound) {
  if (!Array.isArray(inbound) || !inbound.length) return 0;
  var owner = smsRows('Owners').filter(function (o) { return o.OwnerId === d.OwnerId; })[0];
  if (!owner) return 0;
  var n = 0;
  inbound.slice(0, 100).forEach(function (m) {
    var word = String((m && m.text) || '').trim().toLowerCase().replace(/[.!]+$/, '');
    if (SMS_STOP_WORDS.indexOf(word) === -1) return;
    var check = smsNormalisePhone(m.from);
    if (!check.e164) return;
    setSuppression(owner, check.e164, ['promotional', 'service'], true, 'replied ' + word.toUpperCase(), 'customer');
    smsRows('Contacts').filter(function (c) { return c.OwnerId === owner.OwnerId && c.Phone === check.e164 && c.Status !== 'deleted'; }).forEach(function (c) {
      if (c.ConsentPromotional !== 'no') logConsent(owner, c, 'promotional', c.ConsentPromotional, 'no', 'replied ' + word.toUpperCase(), 'customer');
      if (c.ConsentService !== 'no') logConsent(owner, c, 'service', c.ConsentService, 'no', 'replied ' + word.toUpperCase(), 'customer');
      updateRowFromObject(contactsSheet(), c.__row, { ConsentPromotional: 'no', ConsentService: 'no', UnsubscribedAt: nowIso(), UpdatedAt: nowIso() });
    });
    n++;
  });
  return n;
}

/** Messages taken by any phone of this store and never reported in claimHours become 'expired'. */
function smsExpireStale(all, sheet, claimHours, ownerId) {
  var cutoff = new Date(Date.now() - claimHours * 3600000).toISOString();
  all.forEach(function (m) {
    if (m.OwnerId === ownerId && m.Status === 'claimed' && m.ClaimedAt && String(m.ClaimedAt) < cutoff) {
      updateRowFromObject(sheet, m.__row, { Status: 'expired', Error: 'no_report', UpdatedAt: nowIso() });
      m.Status = 'expired';
    }
  });
}

/* ==================== usage & dashboard ==================== */

/**
 * body: from, to (YYYY-MM-DD, local). SMS segments the store's phones
 * submitted, by day, phone and SIM - counted from what the phones reported,
 * so it is an estimate of what the carrier will count. Remaining allowance is
 * worked out only from what the store typed in for each SIM.
 */
function actionSmsUsage(owner, body) {
  var settings = smsStoreSettings(owner.OwnerId);
  var msgs = smsRows('SmsMessages').filter(function (m) { return m.OwnerId === owner.OwnerId && ['submitted', 'sent', 'delivered'].indexOf(m.Status) !== -1; });
  var localDay = function (iso) { var t = Date.parse(iso); return isNaN(t) ? '' : new Date(t + settings.utcOffset * 3600000).toISOString().slice(0, 10); };
  var from = String((body && body.from) || ''), to = String((body && body.to) || '');
  var byDay = {}, byDevice = {}, bySim = {};
  var campaigns = {};
  smsRows('SmsCampaigns').filter(function (c) { return c.OwnerId === owner.OwnerId; }).forEach(function (c) { campaigns[c.CampaignId] = c; });
  msgs.forEach(function (m) {
    var day = localDay(m.SubmittedAt || m.SentAt || m.ClaimedAt);
    if ((from && day < from) || (to && day > to)) return;
    var seg = Number(m.Segments) || 1;
    var simKey = (campaigns[m.CampaignId] || {}).SimKey || '';
    byDay[day] = byDay[day] || { day: day, messages: 0, segments: 0 };
    byDay[day].messages++; byDay[day].segments += seg;
    byDevice[m.DeviceId] = (byDevice[m.DeviceId] || 0) + seg;
    bySim[simKey] = (bySim[simKey] || 0) + seg;
  });
  var sims = smsRows('SmsSims').filter(function (s) { return s.OwnerId === owner.OwnerId; }).map(function (s) {
    var v = smsSimView(s);
    var used = 0;
    if (v.allowance !== null) {
      var since = smsAllowancePeriodStart(v.resetDay, settings.utcOffset);
      msgs.forEach(function (m) { if ((campaigns[m.CampaignId] || {}).SimKey === s.SimKey && localDay(m.SubmittedAt || m.SentAt || m.ClaimedAt) >= since) used += Number(m.Segments) || 1; });
      v.usedThisPeriod = used;
      v.estimatedRemaining = Math.max(0, v.allowance - used);
      v.periodStart = since;
    }
    v.segmentsInRange = bySim[s.SimKey] || 0;
    return v;
  });
  return ok({ days: Object.keys(byDay).sort().map(function (k) { return byDay[k]; }), byDevice: byDevice, sims: sims,
    note: 'Counted from what your phones sent. Your carrier’s own count (and any charges) may differ; Android cannot read your remaining allowance.' });
}

function smsAllowancePeriodStart(resetDay, utcOffset) {
  var now = new Date(Date.now() + utcOffset * 3600000);
  var y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  var r = resetDay || 1;
  if (day < r) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  var dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(r, dim))).toISOString().slice(0, 10);
}

/** Totals for the Contacts & SMS dashboard. All counted from real rows. */
function actionSmsDashboard(owner) {
  var contacts = ownerContactRows(owner);
  var tally = function (key) { var o = {}; contacts.forEach(function (c) { var k = c[key] || ''; o[k] = (o[k] || 0) + 1; }); return o; };
  var msgs = smsRows('SmsMessages').filter(function (m) { return m.OwnerId === owner.OwnerId; });
  var byStatus = {};
  var segments = 0;
  msgs.forEach(function (m) { byStatus[m.Status] = (byStatus[m.Status] || 0) + 1; if (['submitted', 'sent', 'delivered'].indexOf(m.Status) !== -1) segments += Number(m.Segments) || 1; });
  var campaigns = smsRows('SmsCampaigns').filter(function (c) { return c.OwnerId === owner.OwnerId; });
  var devices = smsRows('SmsDevices').filter(function (d) { return d.OwnerId === owner.OwnerId && d.Status === 'active'; });
  return ok({
    contacts: { total: contacts.length, byCategory: tally('Category'), byIsland: tally('Island'), byVillage: tally('Village'),
      promotionalYes: contacts.filter(function (c) { return c.ConsentPromotional === 'yes'; }).length,
      invalidNumbers: contacts.filter(function (c) { return c.PhoneStatus === 'invalid' || c.PhoneStatus === 'check'; }).length },
    campaigns: { total: campaigns.length, active: campaigns.filter(function (c) { return ['queued', 'processing', 'scheduled', 'paused'].indexOf(c.Status) !== -1; }).length },
    messages: { queued: (byStatus.queued || 0) + (byStatus.claimed || 0), submitted: (byStatus.submitted || 0) + (byStatus.sent || 0) + (byStatus.delivered || 0),
      accepted: (byStatus.sent || 0) + (byStatus.delivered || 0), delivered: byStatus.delivered || 0, failed: byStatus.failed || 0, segments: segments },
    devices: { connected: devices.length, onlineRecently: devices.filter(function (d) { return Date.now() - Date.parse(d.LastSeenAt || 0) < 15 * 60000; }).length },
    settings: smsStoreSettings(owner.OwnerId)
  });
}

/* ==================== admin ==================== */

/** Admin. Per store: counts and flags only - no names, numbers or message text. */
function actionAdminSmsOverview(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var stores = {};
  var get = function (id) { return stores[id] = stores[id] || { ownerId: id, contacts: 0, campaigns: 0, sent: 0, failed: 0, optOuts: 0, devices: 0, lastSeenAt: '' }; };
  smsRows('Contacts').forEach(function (c) { if (c.Status !== 'deleted' && c.Status !== 'merged') get(c.OwnerId).contacts++; });
  smsRows('SmsCampaigns').forEach(function (c) { get(c.OwnerId).campaigns++; });
  var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  smsRows('SmsMessages').forEach(function (m) {
    if (String(m.UpdatedAt) < weekAgo) return;
    var s = get(m.OwnerId);
    if (['submitted', 'sent', 'delivered'].indexOf(m.Status) !== -1) s.sent++;
    if (m.Status === 'failed') s.failed++;
  });
  smsRows('SmsSuppression').forEach(function (s) { if (String(s.At) >= weekAgo && s.Kinds) get(s.OwnerId).optOuts++; });
  smsRows('SmsDevices').forEach(function (d) { if (d.Status === 'active') { var s = get(d.OwnerId); s.devices++; if (String(d.LastSeenAt) > s.lastSeenAt) s.lastSeenAt = d.LastSeenAt; } });
  var names = {};
  smsRows('Owners').forEach(function (o) { names[o.OwnerId] = o.StoreName || o.StoreSlug || o.OwnerId; });
  var list = Object.keys(stores).map(function (id) {
    var s = stores[id];
    var settings = smsStoreSettings(id);
    s.storeName = names[id] || id;
    s.suspended = settings.suspended;
    s.flags = [];
    if (s.sent + s.failed >= 20 && s.failed / (s.sent + s.failed) > 0.3) s.flags.push('many failures');
    if (s.sent >= 50 && s.optOuts / s.sent > 0.05) s.flags.push('many opt-outs');
    if (s.sent > settings.limits.maxDailyPerStore * 5) s.flags.push('high volume');
    return s;
  });
  return ok({ stores: list, limits: smsLimits() });
}

/** Admin. body: ownerId, suspend true|false, reason. Stops (or allows) all sending for a store. */
function actionAdminSmsSuspend(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var reason = ctText(body && body.reason, 300);
  if (reason.length < 10) return fail('Write the reason (at least 10 characters).');
  var ownerId = String(body.ownerId || '');
  if (!smsRows('Owners').some(function (o) { return o.OwnerId === ownerId; })) return fail('Store not found.');
  var row = smsStoreRow(ownerId);
  var fields = { Suspended: body.suspend ? 'yes' : '', SuspendedReason: body.suspend ? reason : '', UpdatedAt: nowIso() };
  if (row) updateRowFromObject(smsStoreSheet(), row.__row, fields);
  else appendRowFromObject(smsStoreSheet(), Object.assign({ OwnerId: ownerId }, fields));
  appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: body.suspend ? 'SMS_STORE_SUSPENDED' : 'SMS_STORE_UNSUSPENDED', entityType: 'store', entityId: ownerId, reason: reason });
  return ok({ suspended: !!body.suspend });
}

/** Admin. body: ownerId, reason. A store's contacts - only with a written reason, always audited. */
function actionAdminSmsViewContacts(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var reason = ctText(body && body.reason, 300);
  if (reason.length < 10) return fail('Write why you need to see this store’s contacts (at least 10 characters).');
  var store = smsRows('Owners').filter(function (o) { return o.OwnerId === String(body.ownerId || ''); })[0];
  if (!store) return fail('Store not found.');
  appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'SMS_ADMIN_VIEWED_CONTACTS', entityType: 'store', entityId: store.OwnerId, reason: reason });
  return actionContactsList(store, { offset: body.offset, limit: body.limit, q: body.q });
}

/** Admin. body: campaignId, reason. Emergency stop of one campaign. */
function actionAdminSmsCancelCampaign(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var reason = ctText(body && body.reason, 300);
  if (reason.length < 10) return fail('Write the reason (at least 10 characters).');
  var c = smsRows('SmsCampaigns').filter(function (x) { return x.CampaignId === String(body.campaignId || ''); })[0];
  if (!c) return fail('Campaign not found.');
  var store = smsRows('Owners').filter(function (o) { return o.OwnerId === c.OwnerId; })[0];
  var res = smsCampaignSetStatus(store, c.CampaignId, 'cancelled', 'admin: ' + reason);
  appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'SMS_ADMIN_CANCELLED_CAMPAIGN', entityType: 'sms_campaign', entityId: c.CampaignId, reason: reason });
  return res;
}

/** Admin. body: limits {key: number}. Only known keys, within sane bounds. */
function actionAdminSmsLimits(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var current = smsLimits();
  if (body && body.limits && typeof body.limits === 'object') {
    var bounds = { maxContactsPerStore: [100, 50000], maxCampaignRecipients: [1, 10000], maxDailyPerDevice: [1, 5000], maxDailyPerStore: [1, 20000],
      minIntervalSeconds: [1, 600], defaultIntervalSeconds: [1, 600], batchSize: [1, 200], claimHours: [1, 168], maxDevicesPerStore: [1, 50],
      quietStart: [0, 23], quietEnd: [0, 23], utcOffset: [-12, 14] };
    Object.keys(body.limits).forEach(function (k) {
      if (!bounds[k]) return;
      var n = Number(body.limits[k]);
      if (isFinite(n)) current[k] = Math.max(bounds[k][0], Math.min(bounds[k][1], Math.round(n)));
    });
    PropertiesService.getScriptProperties().setProperty('SMS_LIMITS', JSON.stringify(current));
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'SMS_LIMITS_CHANGED', entityType: 'config', entityId: 'SMS_LIMITS', next: JSON.stringify(current) });
  }
  return ok({ limits: current });
}

/** Admin. Phones across the platform - model, versions, last seen; nothing they sent. */
function actionAdminSmsDevices(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  return ok({ devices: smsRows('SmsDevices').map(function (d) {
    return { deviceId: d.DeviceId, ownerId: d.OwnerId, name: d.Name, status: d.Status, model: d.Model, appVersion: d.AppVersion, androidVersion: d.AndroidVersion, lastSeenAt: d.LastSeenAt };
  }) });
}

/* ==================== Sheets add-on keys ==================== */

/** body: label. A key for the Google Sheets add-on, answered once (only its hash is kept). */
function actionSmsApiKeyCreate(owner, body) {
  var mine = smsRows('SmsApiKeys').filter(function (k) { return k.OwnerId === owner.OwnerId && k.Status === 'active'; });
  if (mine.length >= 5) return fail('You have 5 add-on keys. Remove one first.');
  var key = 'mwk_' + generateToken();
  var id = newId('key');
  appendRowFromObject(smsApiKeySheet(), { KeyId: id, OwnerId: owner.OwnerId, KeyHash: hashSecretToken(key), Label: ctText(body && body.label, 40) || 'Google Sheets', Status: 'active', CreatedAt: nowIso(), LastUsedAt: '', RevokedAt: '' });
  appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_API_KEY_CREATED', entityType: 'api_key', entityId: id });
  return ok({ keyId: id, apiKey: key });
}

function actionSmsApiKeys(owner) {
  return ok({ keys: smsRows('SmsApiKeys').filter(function (k) { return k.OwnerId === owner.OwnerId; })
    .map(function (k) { return { keyId: k.KeyId, label: k.Label, status: k.Status, createdAt: k.CreatedAt, lastUsedAt: k.LastUsedAt }; }) });
}

function actionSmsApiKeyRevoke(owner, body) {
  var k = smsRows('SmsApiKeys').filter(function (x) { return x.OwnerId === owner.OwnerId && x.KeyId === String((body && body.keyId) || ''); })[0];
  if (!k) return fail('Key not found.');
  updateRowFromObject(smsApiKeySheet(), k.__row, { Status: 'revoked', RevokedAt: nowIso(), KeyHash: '' });
  appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SMS_API_KEY_REVOKED', entityType: 'api_key', entityId: k.KeyId });
  return ok({ revoked: true });
}

/** The store an add-on key belongs to, or null. */
function smsOwnerFromApiKey(apiKey) {
  var key = String(apiKey || '');
  if (key.indexOf('mwk_') !== 0) return null;
  var h = hashSecretToken(key);
  var k = smsRows('SmsApiKeys').filter(function (x) { return x.Status === 'active' && x.KeyHash && constantTimeEquals(String(x.KeyHash), h); })[0];
  if (!k) return null;
  try { updateRowFromObject(smsApiKeySheet(), k.__row, { LastUsedAt: nowIso() }); } catch (e) { /* best effort */ }
  return smsRows('Owners').filter(function (o) { return o.OwnerId === k.OwnerId; })[0] || null;
}
