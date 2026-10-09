/**
 * Header adverts: the strip in the homepage header (red on desktop, yellow on
 * phones). (Owner request, Oct 2026.)
 *
 * Each advert is one short line of text and a link. They slide in from the
 * right, stay still for 6 seconds, and slide out to the left (header-ads.js).
 * With no advert running, the three built-in lines in index.html show
 * instead - so an empty or missing tab changes nothing for shoppers.
 *
 * Admin only for now. Sellers buying a slot (like featuring) is a later,
 * separate decision because it involves charging.
 *
 * Tab HeaderAds - created on first use:
 *   AdId | Text | Link | StartDate | EndDate | SortOrder | Status | CreatedAt | UpdatedAt | UpdatedBy
 * Status: active | off. StartDate / EndDate are optional 'YYYY-MM-DD',
 * Kiribati calendar days, both inclusive.
 */
var HEADER_AD_HEADERS = ['AdId', 'Text', 'Link', 'StartDate', 'EndDate', 'SortOrder', 'Status', 'CreatedAt', 'UpdatedAt', 'UpdatedBy'];
var HEADER_AD_TEXT_MAX = 80;
var HEADER_AD_MAX_RUNNING = 10;
var HEADER_ADS_CACHE_KEY = 'v1:headerAds';

function getHeaderAdsSheet() { return getSheetCreating('HeaderAds', HEADER_AD_HEADERS); }

/** Today in Kiribati (UTC+12), 'YYYY-MM-DD'. */
function headerAdToday(ms) {
  var d = new Date((ms || Date.now()) + 12 * 3600000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

function headerAdDay(v) {
  // Sheets turns a typed '2026-10-12' into a Date at midnight Kiribati time;
  // read it back as that same Kiribati day.
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : headerAdToday(v.getTime());
  var s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Is this advert showing on `today`? */
function headerAdRunning(row, today) {
  if (String(row.Status) !== 'active') return false;
  var start = headerAdDay(row.StartDate), end = headerAdDay(row.EndDate);
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

/**
 * A link an advert may open: a page of this site (store, product, category,
 * search...) or a full https:// address. Anything else - javascript:,
 * data:, a bare word - is refused, so an advert can never run script.
 */
function headerAdLinkError(link) {
  var s = String(link == null ? '' : link).trim();
  if (!s) return 'Add the link the advert opens.';
  if (s.length > 500) return 'That link is too long.';
  if (/^https:\/\/[^\s<>"']+$/i.test(s)) return '';
  if (/^(index|store|stores|product|categories|recent|help)\.html(\?[^\s<>"']*)?$/i.test(s)) return '';
  return 'Use a full https:// address, or a Mwakete page such as store.html?store=bong.';
}

/** GET getHeaderAds - what shoppers see now. Cached 5 minutes; cleared on every admin change. */
function actionGetHeaderAds() {
  var ads = getCached(HEADER_ADS_CACHE_KEY, 300, function () {
    var sheet = SpreadsheetApp.getActive().getSheetByName('HeaderAds');
    if (!sheet) return [];
    var today = headerAdToday();
    return sheetToObjects(sheet)
      .filter(function (r) { return headerAdRunning(r, today); })
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .slice(0, HEADER_AD_MAX_RUNNING)
      .map(function (r) { return { text: String(r.Text), link: String(r.Link) }; });
  });
  return ok({ ads: ads || [] });
}

function headerAdView(r, today) {
  return { adId: r.AdId, text: r.Text, link: r.Link, startDate: headerAdDay(r.StartDate), endDate: headerAdDay(r.EndDate),
    sortOrder: Number(r.SortOrder) || 0, status: String(r.Status) === 'active' ? 'active' : 'off', running: headerAdRunning(r, today), updatedAt: r.UpdatedAt };
}

function actionAdminListHeaderAds(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = SpreadsheetApp.getActive().getSheetByName('HeaderAds');
  var today = headerAdToday();
  var rows = sheet ? sheetToObjects(sheet).filter(function (r) { return String(r.Status) !== 'deleted'; }) : [];
  rows.sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); });
  return ok({ ads: rows.map(function (r) { return headerAdView(r, today); }), today: today });
}

/**
 * Add or edit one advert. body: adId (edit), text, link, startDate, endDate,
 * status ('active' | 'off'). A new advert goes to the end of the list.
 */
function actionAdminSaveHeaderAd(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  body = body || {};
  var text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return fail('Write the advert text.');
  if (text.length > HEADER_AD_TEXT_MAX) return fail('Keep the advert to ' + HEADER_AD_TEXT_MAX + ' characters so it fits on a phone.');
  if (/[<>]/.test(text)) return fail('The text cannot contain < or >.');
  var link = String(body.link || '').trim();
  var linkErr = headerAdLinkError(link);
  if (linkErr) return fail(linkErr);
  var start = String(body.startDate || '').trim(), end = String(body.endDate || '').trim();
  if (start && !headerAdDay(start)) return fail('Start date must be a date.');
  if (end && !headerAdDay(end)) return fail('End date must be a date.');
  if (start && end && end < start) return fail('The end date is before the start date.');
  var status = body.status === 'off' ? 'off' : 'active';

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getHeaderAdsSheet();
    var rows = sheetToObjects(sheet).filter(function (r) { return String(r.Status) !== 'deleted'; });
    var now = nowIso();
    var fields = { Text: text, Link: link, StartDate: start, EndDate: end, Status: status, UpdatedAt: now, UpdatedBy: owner.OwnerId };
    var adId = String(body.adId || '');
    if (adId) {
      var row = rows.filter(function (r) { return r.AdId === adId; })[0];
      if (!row) return fail('That advert no longer exists. Please reload.');
      updateRowFromObject(sheet, row.__row, fields);
    } else {
      if (rows.length >= 50) return fail('That is a lot of adverts - delete some old ones first.');
      adId = newId('ad');
      fields.AdId = adId;
      fields.SortOrder = rows.reduce(function (m, r) { return Math.max(m, Number(r.SortOrder) || 0); }, 0) + 1;
      fields.CreatedAt = now;
      appendRowFromObject(sheet, fields);
    }
    invalidateCache([HEADER_ADS_CACHE_KEY]);
    return ok({ adId: adId });
  } finally {
    lock.releaseLock();
  }
}

/** body.order: every advert id in the new order. */
function actionAdminReorderHeaderAds(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var order = Array.isArray(body && body.order) ? body.order.map(String) : null;
  if (!order) return fail('order is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getHeaderAdsSheet();
    var rows = sheetToObjects(sheet).filter(function (r) { return String(r.Status) !== 'deleted'; });
    if (order.length !== rows.length || rows.some(function (r) { return order.indexOf(r.AdId) === -1; })) {
      return fail('The adverts changed. Please reload and try again.');
    }
    rows.forEach(function (r) { updateRowFromObject(sheet, r.__row, { SortOrder: order.indexOf(r.AdId) + 1 }); });
    invalidateCache([HEADER_ADS_CACHE_KEY]);
    return ok({});
  } finally {
    lock.releaseLock();
  }
}

/** Removes an advert from the list (the row stays in the sheet, marked deleted). */
function actionAdminDeleteHeaderAd(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getHeaderAdsSheet();
    var row = findRowById(sheet, 'AdId', String((body && body.adId) || ''));
    if (!row || String(row.Status) === 'deleted') return fail('That advert no longer exists.');
    updateRowFromObject(sheet, row.__row, { Status: 'deleted', UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId });
    invalidateCache([HEADER_ADS_CACHE_KEY]);
    return ok({});
  } finally {
    lock.releaseLock();
  }
}
