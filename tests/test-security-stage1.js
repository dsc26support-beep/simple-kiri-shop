/**
 * Security hardening stage 1 (owner, 16 Nov 2026), on the REAL backend sources:
 *  - the browser is never sent internal error detail (programming errors,
 *    Google service exceptions, sheet names, setup messages) - it gets a plain
 *    message with a reference instead; messages written for people still
 *    come through unchanged;
 *  - the formula guard also covers a leading tab or carriage return.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Status', 'StoreType', 'Island', 'Village', 'DeliveryPickPay', 'Visits'],
    ['o1', 'Bong Store', 'bong', 'active', 'retailer', 'Abaiang', '', 'true', '']],
  Sessions: [['Token', 'OwnerId', 'ExpiresAt', 'CreatedAt']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const logged = [];
box.console = Object.assign({}, console, { error: (m) => logged.push(String(m)) });
const GENERIC = /^Something went wrong on our side\. Please try again in a moment\. \(Ref [0-9a-f]{8}\)$/;
const pem = (e) => box.publicErrorMessage(e, 'test');

/* ---------- which messages reach the browser ---------- */
ok('a message written for people passes unchanged', pem(new Error('Session expired, please log in again')) === 'Session expired, please log in again');
ok('...and another (seller campaigns)', pem(new Error('Choose up to 6 products')) === 'Choose up to 6 products');
for (const [label, err] of [
  ['TypeError (a bug)', new TypeError("Cannot read properties of undefined (reading 'OwnerId')")],
  ['ReferenceError (a bug)', new ReferenceError('fooBar is not defined')],
  ['Google service exception', Object.assign(new Error('Service Spreadsheets timed out while accessing document with id 1AbC'), { name: 'Exception' })],
  ['"Exception:" message', new Error('Exception: You do not have permission to call DriveApp.getFolderById')],
  ['missing sheet tab', new Error('Sheet tab not found: Owners')],
  ['setup message', new Error('Server misconfigured: set PEPPER in Script Properties')],
  ['message with an address', new Error('Request failed for https://api.example.com returned code 500')],
  ['a thrown string', 'boom'],
  ['a very long message', new Error('x'.repeat(400))]
]) {
  const out = pem(err);
  ok(label + ': plain message with a reference', GENERIC.test(out), out);
}
const ref = pem(new TypeError('secret detail')).match(/Ref ([0-9a-f]{8})/)[1];
ok('...the full error is logged under that reference', logged.some((l) => l.indexOf('[' + ref + ']') === 0 && /secret detail/.test(l)), J(logged.slice(-1)));

/* ---------- through doGet / doPost ---------- */
// Products tab missing on purpose: listProducts fails inside the sheet layer.
const viaGet = JSON.parse(box.doGet({ parameter: { action: 'listProducts', storeSlug: 'bong' } }).s);
ok('doGet: a sheet failure is not shown to the browser', viaGet.ok === false && GENERIC.test(viaGet.error) && !/Products|Sheet/.test(viaGet.error), J(viaGet));
const viaPost = JSON.parse(box.doPost({ postData: { contents: JSON.stringify({ action: 'getOwnerProfile', token: 'nope' }) } }).s);
ok('doPost: a refused sign-in still says so in plain words', viaPost.ok === false && /Not authenticated|Session|sign in/i.test(viaPost.error) && !GENERIC.test(viaPost.error), J(viaPost));
ok('doGet: an unknown action is still named', /Unknown action/.test(JSON.parse(box.doGet({ parameter: { action: 'nope' } }).s).error));

/* ---------- formula guard ---------- */
for (const v of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1']) ok('formula guard: ' + JSON.stringify(v) + ' is stored as text', box.sanitizeForSheetCell(v) === "'" + v);
ok('formula guard: ordinary text and numbers unchanged', box.sanitizeForSheetCell('Rice 1kg') === 'Rice 1kg' && box.sanitizeForSheetCell(-5) === -5);

R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
const failed = R.filter((r) => r[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
