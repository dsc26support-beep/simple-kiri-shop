/**
 * Mwakete SMS for Google Sheets (stage 5 of the Contacts & SMS platform).
 *
 * A small Apps Script project that lives in the store's own Google Sheet and
 * talks to the Mwakete backend (the same /exec web app the website uses) with
 * the store's add-on key from Mwakete.com > SMS > Settings.
 *
 * What it can do (the backend decides - SMS_ACTIONS 'key' in SmsCampaigns.gs):
 *   - put the store's contacts in a sheet;
 *   - send rows from a sheet to the store's contacts (checked first, then added);
 *   - check and save a campaign as a DRAFT, to a group, all contacts, or the
 *     rows selected in the contacts sheet;
 *   - put a campaign's results in a sheet.
 * What it can NOT do: start, approve or send a campaign, change consent of
 * existing contacts, delete contacts, or see phones and settings. Starting a
 * campaign always happens on Mwakete.com, where the store sees who it goes to.
 *
 * The key is kept in this Google user's own properties (never in the sheet),
 * so other people the sheet is shared with do not get it.
 */

var MWK_API = 'https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec';
var MWK_SITE = 'https://mwakete.com';
var MWK_KEY_PROP = 'MWAKETE_SMS_KEY';
var MWK_CONTACTS_SHEET = 'Mwakete contacts';
var MWK_ID_HEADER = 'Mwakete ID';
var MWK_IMPORT_MAX = 2000;
var MWK_KINDS = [
  { id: 'promotional', label: 'Promotions' },
  { id: 'service', label: 'Service announcements' },
  { id: 'transactional', label: 'Order & delivery updates' }
];

/* ==================== menu & panel ==================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mwakete SMS')
    .addItem('Open panel', 'mwkShowSidebar')
    .addSeparator()
    .addItem('Get my contacts', 'mwkMenuPullContacts')
    .addToUi();
}

function onInstall() { onOpen(); }

function mwkShowSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Mwakete SMS');
  SpreadsheetApp.getUi().showSidebar(html);
}

function mwkMenuPullContacts() {
  try {
    var r = mwkPullContacts();
    SpreadsheetApp.getUi().alert(r.count + ' contact(s) are in the "' + MWK_CONTACTS_SHEET + '" sheet.');
  } catch (e) {
    SpreadsheetApp.getUi().alert(String(e.message || e));
  }
}

/* ==================== talking to Mwakete ==================== */

function mwkKey_() {
  return PropertiesService.getUserProperties().getProperty(MWK_KEY_PROP) || '';
}

/** One POST to the backend. Throws Error(message) on any refusal. */
function mwkPost_(payload) {
  var res = UrlFetchApp.fetch(MWK_API, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true
  });
  var text = res.getContentText();
  var json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error('Mwakete.com did not answer properly (' + res.getResponseCode() + '). Try again in a minute.');
  }
  if (!json.ok) {
    var err = new Error(json.error || 'Mwakete.com refused that.');
    err.kind = json.errorKind || '';
    throw err;
  }
  return json;
}

function mwkCall_(action, body) {
  var key = mwkKey_();
  if (!key) throw new Error('Connect first: paste your add-on key from Mwakete.com > SMS > Settings.');
  var payload = {};
  Object.keys(body || {}).forEach(function (k) { payload[k] = body[k]; });
  payload.action = action;
  payload.apiKey = key;
  try {
    return mwkPost_(payload);
  } catch (e) {
    // A key removed on Mwakete.com: forget it here so the panel asks again.
    if (e.kind === 'auth') PropertiesService.getUserProperties().deleteProperty(MWK_KEY_PROP);
    throw e;
  }
}

/* ==================== connect ==================== */

/** Checks a key with the backend before keeping it. */
function mwkConnect(key) {
  key = String(key || '').trim();
  if (key.length < 20) throw new Error('That does not look like an add-on key. Make one on Mwakete.com > SMS > Settings.');
  var res = mwkPost_({ action: 'smsDashboard', apiKey: key });
  PropertiesService.getUserProperties().setProperty(MWK_KEY_PROP, key);
  return { connected: true, contacts: res.contacts ? res.contacts.total : 0 };
}

function mwkDisconnect() {
  PropertiesService.getUserProperties().deleteProperty(MWK_KEY_PROP);
  return { connected: false };
}

/** What the panel needs on opening. */
function mwkStatus() {
  if (!mwkKey_()) return { connected: false, kinds: MWK_KINDS, site: MWK_SITE };
  var dash = mwkCall_('smsDashboard', {});
  var groups = mwkCall_('contactGroups', {}).groups || [];
  var categories = mwkCall_('contactCategories', {}).categories || [];
  var templates = mwkCall_('smsTemplates', {}).templates || [];
  var campaigns = (mwkCall_('smsCampaigns', {}).campaigns || []).slice(0, 30).map(function (c) {
    return { campaignId: c.campaignId, name: c.name, statusLabel: c.statusLabel, status: c.status, createdAt: c.createdAt };
  });
  return {
    connected: true, site: MWK_SITE, kinds: MWK_KINDS,
    contacts: dash.contacts ? dash.contacts.total : 0,
    groups: groups.map(function (g) { return { groupId: g.groupId, name: g.name, members: g.members }; }),
    categories: categories, templates: templates.map(function (t) { return { name: t.name, body: t.body, kind: t.kind }; }),
    campaigns: campaigns
  };
}

/* ==================== sheet helpers ==================== */

/** A value a spreadsheet would run as a formula is stored as text. */
function mwkCell_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Replaces a sheet's contents (made if missing) with a header row and rows. */
function mwkWriteSheet_(name, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  if (rows.length) {
    var width = rows[0].length;
    var safe = rows.map(function (r) {
      var out = [];
      for (var i = 0; i < width; i++) out.push(mwkCell_(r[i]));
      return out;
    });
    sheet.getRange(1, 1, safe.length, width).setValues(safe);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function mwkCellText_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** The active sheet's rows as [{header: value}], skipping empty rows. */
function mwkSheetRows_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { headers: values[0] || [], rows: [] };
  var headers = values[0].map(mwkCellText_);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {}, any = false;
    headers.forEach(function (h, j) {
      if (!h) return;
      var v = mwkCellText_(values[i][j]);
      if (v) { row[h] = v; any = true; }
    });
    if (any) rows.push(row);
  }
  return { headers: headers, rows: rows };
}

/* ==================== contacts ==================== */

/** The store's contacts into the "Mwakete contacts" sheet (replaced each time). */
function mwkPullContacts() {
  var res = mwkCall_('contactsExport', {});
  var rows = Utilities.parseCsv(res.csv || '');
  // The export already marks formula-like cells with a leading ' - keep them as text, not twice.
  rows = rows.map(function (r) { return r.map(function (v) { return String(v).charAt(0) === "'" ? String(v).slice(1) : v; }); });
  var sheet = mwkWriteSheet_(MWK_CONTACTS_SHEET, rows);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  return { count: Math.max(0, rows.length - 1) };
}

function mwkImportRows_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = mwkSheetRows_(sheet);
  if (!data.rows.length) throw new Error('This sheet has no rows under its header row.');
  if (data.rows.length > MWK_IMPORT_MAX) throw new Error('At most ' + MWK_IMPORT_MAX + ' rows at a time - split the sheet.');
  // The Mwakete ID column is ours, not something to import.
  data.rows.forEach(function (r) { delete r[MWK_ID_HEADER]; });
  return { sheetName: sheet.getName(), rows: data.rows };
}

/** Checks the active sheet's rows without changing anything. */
function mwkPreviewImport(opts) {
  var src = mwkImportRows_();
  var res = mwkCall_('contactsImportPreview', { rows: src.rows, onDuplicate: opts && opts.onDuplicate === 'update' ? 'update' : 'skip' });
  return { sheetName: src.sheetName, total: src.rows.length, counts: res.counts || {}, columns: res.columns || {},
    problems: (res.rows || []).filter(function (r) { return r.action === 'invalid' || r.action === 'repeat'; }).slice(0, 20) };
}

/**
 * Adds the active sheet's rows. opts: onDuplicate skip|update, groupId?,
 * category?, consentPromotional (true) + consentSource - only when the store
 * says these people agreed and how (the backend refuses a yes with no source).
 */
function mwkApplyImport(opts) {
  opts = opts || {};
  var src = mwkImportRows_();
  var body = { rows: src.rows, source: 'google_sheets', onDuplicate: opts.onDuplicate === 'update' ? 'update' : 'skip' };
  if (opts.groupId) body.groupId = String(opts.groupId);
  if (opts.category) body.category = String(opts.category);
  if (opts.consentPromotional) {
    body.consent = { promotional: 'yes' };
    body.consentSource = String(opts.consentSource || '');
  }
  var res = mwkCall_('contactsImportApply', body);
  return { added: res.added, updated: res.updated, skipped: res.skipped, invalid: res.invalid, full: !!res.full };
}

/** Mwakete IDs of the rows selected in the contacts sheet. */
function mwkSelectedContactIds_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(mwkCellText_);
  var col = headers.indexOf(MWK_ID_HEADER);
  if (col === -1) throw new Error('Select rows in the "' + MWK_CONTACTS_SHEET + '" sheet (use Get my contacts first).');
  var ids = [];
  var seen = {};
  var ranges = sheet.getActiveRangeList() ? sheet.getActiveRangeList().getRanges() : [];
  ranges.forEach(function (range) {
    var first = range.getRow(), n = range.getNumRows();
    for (var r = Math.max(2, first); r < first + n; r++) {
      var id = mwkCellText_(sheet.getRange(r, col + 1).getValue());
      if (id && !seen[id]) { seen[id] = true; ids.push(id); }
    }
  });
  if (!ids.length) throw new Error('Select the rows of the people to send to (not the header row).');
  return ids;
}

/* ==================== campaigns (drafts only) ==================== */

/** spec: name, kind, body, to: 'group'|'all'|'selected', groupId. */
function mwkCampaignBody_(spec) {
  spec = spec || {};
  var body = { name: String(spec.name || ''), kind: String(spec.kind || 'promotional'), body: String(spec.body || '') };
  if (spec.to === 'all') body.allContacts = true;
  else if (spec.to === 'selected') body.contactIds = mwkSelectedContactIds_();
  else if (spec.groupId) body.groupIds = [String(spec.groupId)];
  else throw new Error('Choose who it goes to.');
  return body;
}

/** Who would get it and how many SMS - nothing is saved. */
function mwkEstimate(spec) {
  var res = mwkCall_('smsCampaignEstimate', mwkCampaignBody_(spec));
  return { recipients: res.recipients, segments: res.segments, skipped: res.skipped || {}, previews: res.previews || [],
    tooMany: !!res.tooMany, maxRecipients: res.maxRecipients };
}

/** Saves a DRAFT. Starting it happens on Mwakete.com. */
function mwkSaveDraft(spec) {
  var res = mwkCall_('smsCampaignSave', mwkCampaignBody_(spec));
  return { campaignId: res.campaign.campaignId, name: res.campaign.name, approveUrl: MWK_SITE + '/owner/sms.html#campaigns' };
}

/** A campaign's results into a sheet named after it. */
function mwkCampaignResults(campaignId) {
  var res = mwkCall_('smsCampaignExport', { campaignId: String(campaignId || '') });
  var list = mwkCall_('smsCampaigns', {}).campaigns || [];
  var c = list.filter(function (x) { return x.campaignId === campaignId; })[0];
  var rows = Utilities.parseCsv(res.csv || '');
  rows = rows.map(function (r) { return r.map(function (v) { return String(v).charAt(0) === "'" ? String(v).slice(1) : v; }); });
  var name = ('Results - ' + (c ? c.name : campaignId)).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 90);
  var sheet = mwkWriteSheet_(name, rows);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  return { count: Math.max(0, rows.length - 1), sheetName: name };
}
