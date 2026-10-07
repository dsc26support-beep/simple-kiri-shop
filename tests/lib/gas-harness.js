/**
 * Runs the REAL apps-script/*.gs sources in a vm against an in-memory
 * spreadsheet, so backend flows (checkout -> fulfil -> cancel, imports...)
 * can be tested end to end without Google. Only the Apps Script services the
 * code touches are stubbed; sheets behave like row-1-headers grids.
 */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const DIR = '/home/user/simple-kiri-shop/apps-script';

class FakeSheet {
  constructor(name, rows) { this.name = name; this.grid = rows ? rows.map((r) => r.slice()) : []; }
  getName() { return this.name; }
  getLastRow() { return this.grid.length; }
  getLastColumn() { return this.grid.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) {
    const sheet = this;
    numRows = numRows || 1; numCols = numCols || 1;
    const cell = (r, c) => { const x = (sheet.grid[r - 1] || [])[c - 1]; return x === undefined ? '' : x; };
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) { const line = []; for (let c = 0; c < numCols; c++) line.push(cell(row + r, col + c)); out.push(line); }
        return out;
      },
      getValue() { return cell(row, col); },
      getDisplayValues() { return this.getValues().map((line) => line.map((v) => (v === null || v === undefined ? '' : String(v)))); },
      setValues(vals) {
        vals.forEach((line, r) => {
          while (sheet.grid.length < row + r) sheet.grid.push([]);
          const target = sheet.grid[row + r - 1];
          line.forEach((v, c) => { target[col + c - 1] = v; });
        });
        return this;
      },
      setValue(v) { return this.setValues([[v]]); }
    };
  }
  appendRow(values) { this.grid.push(values.slice()); }
  deleteRow(n) { this.grid.splice(n - 1, 1); }
  // Test helper: rows as objects.
  objects() {
    const [h, ...rest] = this.grid;
    return rest.map((r) => Object.fromEntries((h || []).map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
  }
}

function fakeSpreadsheet(sheets, name) {
  return {
    getName: () => name || 'Mwakete',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n)),
    getSheets: () => Object.values(sheets)
  };
}

/**
 * tabs: the bound Mwakete spreadsheet. opts.external: other spreadsheets a
 * seller has "shared" with Mwakete, { id: { title, tabs: { name: rows } } } -
 * openById opens those and throws (as Google does) for anything else.
 */
function makeBox(tabs, opts) {
  const sheets = {};
  Object.keys(tabs || {}).forEach((name) => { sheets[name] = new FakeSheet(name, tabs[name]); });
  const ss = fakeSpreadsheet(sheets);
  const external = {};
  Object.entries((opts && opts.external) || {}).forEach(([id, def]) => {
    const t = {};
    Object.keys(def.tabs).forEach((n) => { t[n] = new FakeSheet(n, def.tabs[n]); });
    external[id] = fakeSpreadsheet(t, def.title);
  });
  const cache = {};
  const props = {};
  const mail = [];
  const box = {
    console, JSON, Math, Date, Number, String, Object, Array, Boolean, RegExp, Error, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    SpreadsheetApp: { getActive: () => ss, getActiveSpreadsheet: () => ss,
      openById: (id) => { if (external[id]) return external[id]; throw new Error('You do not have permission to access the requested document.'); } },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; },
      remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach((k) => delete cache[k]),
      getAll: (ks) => Object.fromEntries(ks.filter((k) => k in cache).map((k) => [k, cache[k]])), putAll: (o) => Object.assign(cache, o)
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, ''),
      sleep() {},
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, data) => Array.from(crypto.createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest()).map((b) => (b > 127 ? b - 256 : b))
    },
    MailApp: { sendEmail: (...a) => mail.push(a) },
    Logger: { log() {} },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@x.com' }), getScriptTimeZone: () => 'Pacific/Tarawa' },
    UrlFetchApp: { fetch: () => { throw new Error('UrlFetchApp not stubbed'); } },
    __sheets: sheets, __props: props, __mail: mail, __cache: cache, __external: external
  };
  vm.createContext(box);
  fs.readdirSync(DIR).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(`${DIR}/${f}`, 'utf8'), box, { filename: f });
  });
  return box;
}

module.exports = { makeBox, FakeSheet };
