/**
 * Runs the REAL apps-script/*.gs sources in a vm against an in-memory
 * spreadsheet, so backend flows (checkout -> fulfil -> cancel, imports...)
 * can be tested end to end without Google. Only the Apps Script services the
 * code touches are stubbed; sheets behave like row-1-headers grids.
 */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const DIR = require('path').resolve(__dirname, '../../apps-script');

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
      setValue(v) { return this.setValues([[v]]); },
      // Blanks the cells, like Sheets: the rows stay (recomputeSellerBadges).
      clearContent() {
        for (let r = 0; r < numRows; r++) {
          const target = sheet.grid[row + r - 1];
          if (target) for (let c = 0; c < numCols; c++) target[col + c - 1] = '';
        }
        return this;
      }
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
  const drive = { n: 0, files: {}, folders: {} };
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
      // A string becomes its UTF-8 bytes (signed), like Apps Script.
      newBlob: (bytes, type, name) => ({ getBytes: () => (typeof bytes === 'string' ? Array.from(Buffer.from(bytes, 'utf8')).map((b) => (b > 127 ? b - 256 : b)) : Array.from(bytes)), getContentType: () => type, getName: () => name }),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, data) => Array.from(crypto.createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      // Apps Script's HMAC (signed bytes, like computeDigest). Added for the POS integration hub.
      MacAlgorithm: { HMAC_SHA_256: 'sha256' },
      // Takes strings or Apps Script (signed) byte arrays, like the real one (Passwords.gs PBKDF2).
      computeHmacSha256Signature: (value, key) => {
        const buf = (x) => (Array.isArray(x) ? Buffer.from(x.map((b) => b & 255)) : x);
        return Array.from(crypto.createHmac('sha256', buf(key)).update(buf(value)).digest()).map((b) => (b > 127 ? b - 256 : b));
      }
    },
    MailApp: { sendEmail: (...a) => mail.push(a) },
    Logger: { log() {} },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@x.com' }), getScriptTimeZone: () => 'Pacific/Tarawa' },
    UrlFetchApp: { fetch: () => { throw new Error('UrlFetchApp not stubbed'); } },
    // In-memory Drive: files are private unless setSharing is called (recorded).
    DriveApp: (() => {
      const make = (id, blob) => ({ id, blob, trashed: false, sharing: null,
        getId() { return id; }, getBlob() { return blob; }, getUrl() { return 'https://drive.example/' + id; },
        setTrashed(t) { this.trashed = !!t; }, setSharing(a, p) { this.sharing = [a, p]; } });
      const folder = (fid) => ({ getId: () => fid, createFile: (blob) => { const id = 'file_' + (++drive.n); drive.files[id] = make(id, blob); drive.files[id].folder = fid; return drive.files[id]; } });
      return {
        createFolder: (name) => { const fid = 'folder_' + (++drive.n); drive.folders[fid] = name; return folder(fid); },
        getFolderById: (fid) => { if (!drive.folders[fid]) throw new Error('No folder'); return folder(fid); },
        getFileById: (id) => { const f = drive.files[id]; if (!f || f.trashed) throw new Error('No item with the given ID could be found'); return f; },
        Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }
      };
    })(),
    __sheets: sheets, __props: props, __mail: mail, __cache: cache, __external: external, __drive: drive
  };
  vm.createContext(box);
  fs.readdirSync(DIR).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(`${DIR}/${f}`, 'utf8'), box, { filename: f });
  });
  if (!(opts && opts.guest)) signInDefaultShopper(box, sheets);
  return box;
}

/**
 * Guests are viewers (owner decision, Oct 2026): ordering, booking and
 * messaging a seller need a signed-in customer. Most tests are about
 * something else, so by default a calling shopper is signed in: a REAL
 * Customers + CustomerSessions row, whose token is added to any of those
 * calls that names no customerSession at all - the server's own check still
 * runs on it. It has no email, so an order keeps the email the test sent.
 * A test of the guest path passes customerSession: '' (or makeBox(..., { guest: true })).
 */
const TEST_SHOPPER_TOKEN = 'harness-shopper-session';
function signInDefaultShopper(box, sheets) {
  const add = (name, head, row) => {
    if (!sheets[name]) sheets[name] = new FakeSheet(name, [head]);
    const grid = sheets[name].grid;
    grid.push(grid[0].map((h) => (h in row ? row[h] : '')));
  };
  add('Customers', ['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    { CustomerId: 'cus_harness', Name: 'Test Shopper', Email: '', EmailVerified: 'yes' });
  add('CustomerSessions', ['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'],
    { Token: TEST_SHOPPER_TOKEN, CustomerId: 'cus_harness', ExpiresAt: new Date(Date.now() + 9e8).toISOString() });
  ['actionCreateOrder', 'actionCreateBookingRequest', 'actionSendMessage', 'actionSendChatImage'].forEach((n) => {
    const real = box[n];
    if (typeof real !== 'function') return;
    box[n] = function (body) {
      if (body && typeof body === 'object' && !body.token && !('customerSession' in body)) {
        body = Object.assign({}, body, { customerSession: TEST_SHOPPER_TOKEN });
      }
      return real.apply(this, arguments.length > 1 ? [body].concat([].slice.call(arguments, 1)) : [body]);
    };
  });
}

/**
 * A real (tiny, 40x40) PNG, base64 - passes the backend's byte sniffing as an
 * image. Used for driver ID, face and signature photos in tests.
 */
function testPngBase64(w, h) {
  const zlib = require('zlib');
  w = w || 40; h = h || 40;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 200);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/** The extra fields a driver application needs since Oct 2026 (DriverOnboarding.gs). */
function driverDocs(extra) {
  const png = testPngBase64();
  return Object.assign({ messenger: 'dan.driver', idType: 'national', idNumber: 'N1234567', idPhotoBase64: png, selfieBase64: png,
    faceResult: 'passed', faceScore: 0.41,
    contract: { version: '2026-10-v1', method: 'digital', agree: true, signedName: 'Dan Driver', signatureBase64: png } }, extra || {});
}

module.exports = { makeBox, FakeSheet, TEST_SHOPPER_TOKEN, testPngBase64, driverDocs };
