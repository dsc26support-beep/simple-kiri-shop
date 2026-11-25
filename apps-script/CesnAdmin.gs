/**
 * CESN administrator controls (Stage 8). Mwakete admins only (isOwnerAdmin):
 * the platform-wide frequency limits, the price-drop threshold, the master
 * switch and per-category on/off, plus read-only monitoring (volumes, skipped
 * counts, push-subscription count, recent campaign activity). All limits live
 * in Script Properties (EngagementEngine.gs cesnConfig reads them), so nothing
 * is hard-coded and a change takes effect immediately for automatic and manual
 * sends alike. These controls are anti-abuse / infrastructure settings - they
 * are never a paid seller feature. Every config change is written to CesnAudit.
 */

function cesnAdminConfig_() {
  var cfg = cesnConfig();
  return {
    enabled: cfg.enabled, maxPerDay: cfg.maxPerDay, maxPerWeek: cfg.maxPerWeek,
    minIntervalMin: cfg.minIntervalMin, dropPct: cfg.dropPct, dwellHours: cfg.dwellHours,
    disabledCategories: cfg.disabled
  };
}

function actionGetCesnAdmin(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var now = Date.now();
  var within = function (iso, ms) { var t = new Date(iso).getTime(); return !isNaN(t) && (now - t) < ms; };
  var sum = function (arr, f) { return arr.reduce(function (s, a) { return s + (Number(a[f]) || 0); }, 0); };

  var audit = [];
  try { audit = sheetToObjects(getSheet('CesnAudit')); } catch (e) { audit = []; }
  var day = audit.filter(function (a) { return within(a.CreatedAt, 86400000); });
  var week = audit.filter(function (a) { return within(a.CreatedAt, 7 * 86400000); });

  var pushCount = 0;
  try { pushCount = sheetToObjects(getSheet('PushSubscriptions')).filter(function (s) { return String(s.Status) === 'active'; }).length; } catch (e) {}

  var recent = [];
  try {
    recent = sheetToObjects(getSheet('EngagementCampaigns'))
      .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })
      .slice(0, 25)
      .map(function (c) { return { campaignId: c.CampaignId, storeSlug: c.StoreSlug, category: c.Category, status: c.Status, queued: Number(c.Queued) || 0, createdAt: c.CreatedAt }; });
  } catch (e) {}

  var cfg = cesnConfig();
  return ok({
    config: cesnAdminConfig_(),
    categories: Object.keys(CESN_CATEGORIES).map(function (k) {
      return { key: k, label: CESN_CATEGORIES[k].label, auto: CESN_CATEGORIES[k].auto, enabled: cfg.disabled.indexOf(k) === -1 };
    }),
    volumes: {
      queuedToday: sum(day, 'Queued'), queuedWeek: sum(week, 'Queued'),
      skippedFreqWeek: sum(week, 'SkippedFreq'), skippedDupWeek: sum(week, 'SkippedDup'),
      eventsWeek: week.length
    },
    pushSubscriptions: pushCount,
    pushEnabled: (typeof pushEnabled === 'function') ? pushEnabled() : false,
    recentCampaigns: recent
  });
}

function actionSetCesnConfig(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var p = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var setNum = function (key, val, min, max) {
      var n = Number(val);
      if (isNaN(n) || n < min || n > max) throw new Error('Value out of range for ' + key);
      p.setProperty(key, String(n));
    };
    if (body.enabled !== undefined) p.setProperty('CESN_ENABLED', (body.enabled === true || body.enabled === 'true') ? 'true' : 'false');
    if (body.maxPerDay !== undefined) setNum('CESN_MAX_PER_DAY', body.maxPerDay, 0, 50);
    if (body.maxPerWeek !== undefined) setNum('CESN_MAX_PER_WEEK', body.maxPerWeek, 0, 200);
    if (body.minIntervalMin !== undefined) setNum('CESN_MIN_INTERVAL_MIN', body.minIntervalMin, 0, 10080);
    if (body.dropPct !== undefined) setNum('CESN_PRICE_DROP_PCT', body.dropPct, 1, 90);
    if (body.dwellHours !== undefined) setNum('CESN_PRICE_DWELL_HOURS', body.dwellHours, 0, 720);
    if (body.disabledCategories !== undefined) {
      var raw = Array.isArray(body.disabledCategories) ? body.disabledCategories : String(body.disabledCategories).split(',');
      var list = raw.map(function (s) { return String(s).trim(); }).filter(function (k) { return !!CESN_CATEGORIES[k]; });
      p.setProperty('CESN_CATEGORIES_OFF', list.join(','));
    }
  } catch (e) {
    lock.releaseLock();
    return fail(String(e.message || e));
  }
  lock.releaseLock();
  // Audit the change (best-effort; never blocks the save).
  try {
    appendRowFromObject(getSheet('CesnAudit'), {
      EventId: newId('cesn'), StoreSlug: '', Category: 'admin_config', SourceKey: 'admin:' + owner.OwnerId,
      Audience: '', Queued: '', SkippedFreq: '', SkippedDup: '', CreatedAt: nowIso()
    });
  } catch (e) {}
  return ok({ saved: true, config: cesnAdminConfig_() });
}
