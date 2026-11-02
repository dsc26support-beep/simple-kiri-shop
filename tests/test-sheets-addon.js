/**
 * The Google Sheets add-on (sheets-addon/Code.gs, stage 5) end to end: the
 * add-on's own code runs against an in-memory spreadsheet, and every
 * UrlFetchApp call goes into the REAL backend doPost (gas-harness), exactly as
 * it would reach the Apps Script web app. Nothing is mocked on the backend side.
 *
 * Holds: the key lives in user properties (never the sheet); a wrong or removed
 * key is refused and forgotten; sheet rows are checked before they are added;
 * consent is only recorded with a stated source; formula-like cells are written
 * as text; a campaign can only be saved as a DRAFT - the key cannot start it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fails = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fails++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + String(e).slice(0, 400) + ']')); } };
const FUT = new Date(Date.now() + 86400000).toISOString();

/* ---------- the backend (real .gs) ---------- */
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'], ['own_a', 'a', 'A Shop', 'active', 'retailer', 'a@x.test']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]]
});
box.__props.CONTACTS_SMS = 'on';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.Logger = { log() {} };
const site = (action, body) => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(Object.assign({ action, token: 'tok-a' }, body || {})) } }).s);
// Read the way the backend reads (smsRows strips the sheet's formula-guard apostrophe).
const rows = (t) => (box.__sheets[t] ? box.smsRows(t) : []);

const KEY = site('smsApiKeyCreate', { label: 'Office sheet' }).apiKey;
const GROUP = site('contactGroupSave', { name: 'Betio' }).group.groupId;
ok('(setup) the store made a key and a group on Mwakete.com', !!KEY && !!GROUP);

/* ---------- a tiny Google Sheets ---------- */
function makeSpreadsheet() {
  const sheets = {};
  let active = null;
  let selection = [];
  const mkSheet = (name) => {
    const s = {
      name, grid: [], quoted: {}, formulas: [],
      getName: () => name,
      clear: () => { s.grid = []; s.quoted = {}; },
      setFrozenRows: () => s,
      getLastColumn: () => Math.max(0, ...s.grid.map((r) => r.length)),
      getDataRange: () => ({ getValues: () => s.grid.map((r) => r.slice()) }),
      getRange: (r, c, nr, nc) => ({
        getRow: () => r, getNumRows: () => nr || 1,
        getValue: () => ((s.grid[r - 1] || [])[c - 1] === undefined ? '' : s.grid[r - 1][c - 1]),
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push(((s.grid[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
        setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => {
          const rr = r - 1 + i, cc = c - 1 + j;
          s.grid[rr] = s.grid[rr] || [];
          // Like Sheets: a leading ' makes the rest plain text; an unquoted = is a formula.
          let stored = v;
          if (typeof v === 'string' && v.charAt(0) === "'") { stored = v.slice(1); s.quoted[rr + ',' + cc] = true; }
          else if (typeof v === 'string' && /^[=+\-@]/.test(v)) s.formulas.push(v);
          s.grid[rr][cc] = stored;
        }))
      }),
      getActiveRangeList: () => ({ getRanges: () => selection })
    };
    return s;
  };
  const ss = {
    sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = mkSheet(n)),
    getActiveSheet: () => active,
    setActiveSheet: (s) => { active = s; return s; },
    select: (n, ranges) => { active = sheets[n]; selection = ranges.map(([r, nr]) => ({ getRow: () => r, getNumRows: () => nr })); },
    add: (n, grid) => { const s = mkSheet(n); s.grid = grid; sheets[n] = s; active = s; return s; }
  };
  return ss;
}

function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

/* ---------- the add-on (its real source) ---------- */
const ss = makeSpreadsheet();
const userProps = {};
const fetches = [];
const addon = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }), alert() {}, showSidebar() {} }) },
  HtmlService: { createHtmlOutputFromFile: () => ({ setTitle() { return this; } }) },
  PropertiesService: { getUserProperties: () => ({ getProperty: (k) => (k in userProps ? userProps[k] : null), setProperty: (k, v) => { userProps[k] = v; }, deleteProperty: (k) => { delete userProps[k]; } }) },
  Utilities: { parseCsv },
  UrlFetchApp: {
    fetch: (url, opts) => {
      fetches.push({ url, opts });
      const s = box.doPost({ postData: { contents: opts.payload } }).s;
      return { getContentText: () => s, getResponseCode: () => 200 };
    }
  }
};
vm.createContext(addon);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sheets-addon', 'Code.gs'), 'utf8'), addon);
const call = (fn, ...args) => { try { return { ok: true, v: addon[fn](...args) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } };

/* ---------- connecting ---------- */
let r = call('mwkStatus');
ok('not connected: the panel asks for a key', r.ok && r.v.connected === false, JSON.stringify(r));
r = call('mwkPullContacts');
ok('...and nothing works without one', !r.ok && /Connect first/.test(r.error), r.error);
r = call('mwkConnect', 'x'.repeat(40));
ok('a wrong key is refused by Mwakete', !r.ok && /not valid/.test(r.error), r.error);
ok('...and not kept', !userProps.MWAKETE_SMS_KEY);
r = call('mwkConnect', '  ' + KEY + ' ');
ok('the right key connects', r.ok && r.v.connected === true, JSON.stringify(r));
ok('...kept in this Google user\'s properties, not in the sheet', userProps.MWAKETE_SMS_KEY === KEY && Object.keys(ss.sheets).length === 0);
ok('...sent to the same web app as the website, as text/plain JSON (no secret in the URL)',
  fetches.every((f) => /\/exec$/.test(f.url) && f.opts.method === 'post' && /text\/plain/.test(f.opts.contentType) && f.url.indexOf(KEY) === -1));
r = call('mwkStatus');
ok('connected: groups, kinds and campaigns for the panel', r.ok && r.v.connected && r.v.groups.some((g) => g.groupId === GROUP) && r.v.kinds.length === 3, JSON.stringify(r).slice(0, 300));

/* ---------- sheet rows -> contacts ---------- */
ss.add('Customers', [
  ['First name', 'Last name', 'Phone', 'Island', 'Notes'],
  ['Teraoi', 'Kaitu', '73011111', 'Tarawa', ''],
  ['Bwebwe', '', 73022222, 'Abaiang', 'paid by cash'],      // a number, as Sheets stores it
  ['Repeat', '', '+686 7301 1111', '', ''],                 // same number as row 2
  ['NoPhone', '', '', '', ''],
  ['=HYPERLINK("http://evil")', '', '73033333', '', ''],    // a formula-looking name
  ['', '', '', '', '']                                       // empty row, ignored
]);
r = call('mwkPreviewImport', {});
ok('checking rows changes nothing', r.ok && rows('Contacts').length === 0, JSON.stringify(r));
ok('...and says what would happen: 3 new, 1 repeated, 1 unusable',
  r.ok && r.v.total === 5 && r.v.counts.new === 3 && r.v.counts.repeat === 1 && r.v.counts.invalid === 1, JSON.stringify(r.v && r.v.counts));
r = call('mwkApplyImport', { groupId: GROUP, consentPromotional: true, consentSource: '' });
ok('saying they agreed to promotions needs to say how', !r.ok && /agreed/.test(r.error), r.error);
ok('...and nothing was added', rows('Contacts').length === 0);
r = call('mwkApplyImport', { groupId: GROUP, consentPromotional: true, consentSource: 'sign-up sheet at the shop, Oct 2026' });
ok('adding them: 3 added, 2 skipped', r.ok && r.v.added === 3 && r.v.skipped + r.v.invalid === 2, JSON.stringify(r));
const cs = rows('Contacts');
ok('...marked as from Google Sheets, numbers in +686 form',
  cs.every((c) => c.Source === 'google_sheets') && cs.some((c) => c.Phone === '+68673011111') && cs.some((c) => c.Phone === '+68673022222'), JSON.stringify(cs.map((c) => [c.Source, c.Phone])));
ok('...with the promotions yes and how they agreed, logged', cs.every((c) => c.ConsentPromotional === 'yes' && /sign-up sheet/.test(c.ConsentSource)) && rows('ContactConsentLog').length === 3);
ok('...and in the chosen group', rows('ContactGroupMembers').filter((m) => m.GroupId === GROUP).length === 3);
r = call('mwkApplyImport', {});
ok('adding the same rows again adds nobody twice', r.ok && r.v.added === 0 && rows('Contacts').length === 3, JSON.stringify(r));

/* ---------- contacts -> sheet ---------- */
r = call('mwkPullContacts');
const cSheet = ss.getSheetByName('Mwakete contacts');
ok('Get my contacts fills the "Mwakete contacts" sheet', r.ok && r.v.count === 3 && cSheet && cSheet.grid.length === 4, JSON.stringify(r));
const head = cSheet.grid[0];
ok('...with the export columns, Mwakete ID last', head[0] === 'First name' && head.indexOf('Phone') !== -1 && head[head.length - 1] === 'Mwakete ID', head.join('|'));
ok('...a formula-looking name is stored as text, never run', cSheet.formulas.length === 0 && cSheet.grid.some((row) => row[0] === '=HYPERLINK("http://evil")'), JSON.stringify(cSheet.formulas));
ok('...+686 numbers stay text (not turned into sums)', Object.keys(cSheet.quoted).length >= 3 && cSheet.grid.slice(1).every((row) => /^\+686/.test(row[head.indexOf('Phone')])));

/* ---------- a campaign draft from selected rows ---------- */
ss.select('Mwakete contacts', [[2, 2]]);   // rows 2-3: two people
const spec = { name: 'Rice offer', kind: 'promotional', body: 'Mauri {first_name}, rice is in at A Shop!', to: 'selected' };
r = call('mwkEstimate', spec);
ok('checking a campaign to the selected rows: 2 people, 2 SMS', r.ok && r.v.recipients === 2 && r.v.segments === 2, JSON.stringify(r));
ok('...with a preview of the real text', r.ok && /^Mauri \S+, rice is in at A Shop!$/.test(r.v.previews[0].text), JSON.stringify(r.v && r.v.previews));
ok('...nothing saved yet', rows('SmsCampaigns').length === 0);
r = call('mwkSaveDraft', spec);
const camp = rows('SmsCampaigns')[0];
ok('Save draft saves a DRAFT', r.ok && camp && camp.Status === 'draft' && JSON.parse(camp.ContactIdsJson).length === 2, JSON.stringify(r));
ok('...and points to Mwakete.com to start it', r.ok && /mwakete\.com\/owner\/sms\.html/.test(r.v.approveUrl));
r = call('mwkCall_', 'smsCampaignApprove', { campaignId: camp.CampaignId, confirmRecipients: 2 });
ok('the key can never start a campaign', !r.ok && /Mwakete\.com/.test(r.error) && rows('SmsCampaigns')[0].Status === 'draft', r.error);
ss.select('Mwakete contacts', [[1, 1]]);
r = call('mwkEstimate', spec);
ok('selecting only the header row is caught', !r.ok && /Select the rows/.test(r.error), r.error);
ss.select('Customers', [[2, 1]]);
r = call('mwkEstimate', spec);
ok('selecting in a sheet with no Mwakete ID column is caught', !r.ok && /Mwakete contacts/.test(r.error), r.error);
r = call('mwkEstimate', Object.assign({}, spec, { to: 'group', groupId: GROUP }));
ok('...to a group works too', r.ok && r.v.recipients === 3, JSON.stringify(r));
r = call('mwkEstimate', Object.assign({}, spec, { to: 'all' }));
ok('...and to all contacts', r.ok && r.v.recipients === 3, JSON.stringify(r));

/* ---------- results ---------- */
r = call('mwkCampaignResults', camp.CampaignId);
ok('campaign results go into their own sheet', r.ok && !!ss.getSheetByName(r.v.sheetName) && /Rice offer/.test(r.v.sheetName), JSON.stringify(r));

/* ---------- a key removed on Mwakete.com ---------- */
const keyId = site('smsApiKeys').keys[0].keyId;
site('smsApiKeyRevoke', { keyId });
r = call('mwkStatus');
ok('after the key is removed on Mwakete.com the add-on is refused', !r.ok && /not valid/.test(r.error), r.error);
ok('...and forgets the key, so the panel asks again', !userProps.MWAKETE_SMS_KEY && call('mwkStatus').v.connected === false);

/* ---------- the panel ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'sheets-addon', 'Sidebar.html'), 'utf8');
const code = fs.readFileSync(path.join(__dirname, '..', 'sheets-addon', 'Code.gs'), 'utf8');
const used = Array.from(new Set((html.match(/run\('(mwk\w+)'/g) || []).map((m) => m.slice(5, -1))));
ok('every server function the panel calls exists', used.length >= 8 && used.every((f) => new RegExp('function ' + f + '\\(').test(code)), used.join(','));
ok('the panel never holds the key after connecting (field cleared) and builds text with textContent',
  /\$\('key'\)\.value = ''/.test(html) && !/innerHTML\s*=\s*[^'"]/.test(html.replace(/innerHTML = ''/g, '')));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sheets-addon', 'appsscript.json'), 'utf8'));
ok('the manifest asks only for this sheet, the menu/panel and outside requests',
  manifest.oauthScopes.length === 3 && manifest.oauthScopes.some((s) => /spreadsheets\.currentonly$/.test(s)));

console.log(`\n${pass}/${pass + fails} passed`);
process.exit(fails ? 1 : 0);
