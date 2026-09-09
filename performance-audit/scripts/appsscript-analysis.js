// Static analysis of the Apps Script backend: for every action the frontend can
// call, how many FULL-TAB reads it performs, what it writes, and whether it is
// cached or locked. Reads .gs source only - executes nothing, changes nothing.
//
// Why full-tab reads are the unit: Db.gs's sheetToObjects(getSheet('X')) pulls
// EVERY row of a tab into memory. Google Sheets has no server-side query, so a
// "find one row" is a whole-table scan, and cost grows with the tab, not with
// the answer.
const fs = require('fs');
const REPO = '/home/user/simple-kiri-shop/';
const DIR = REPO + 'apps-script/';

let src = '';
const perFile = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gs'))) {
  perFile[f] = fs.readFileSync(DIR + f, 'utf8');
  src += '\n' + perFile[f];
}

// Split the whole backend into top-level functions.
const fns = {};
const re = /^function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
let m;
const starts = [];
while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
starts.forEach((s, i) => {
  fns[s.name] = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
});

const strip = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function directCosts(body) {
  const b = strip(body);
  const full = [...b.matchAll(/sheetToObjects\(\s*getSheet\(\s*'([^']+)'/g)].map((x) => x[1]);
  const fullVar = (b.match(/sheetToObjects\(\s*(?!getSheet)/g) || []).length;
  const findById = [...b.matchAll(/findRowById\(\s*getSheet\(\s*'([^']+)'/g)].map((x) => x[1]);
  const findSecret = [...b.matchAll(/findRowBySecret\(\s*getSheet\(\s*'([^']+)'/g)].map((x) => x[1]);
  return {
    fullScans: full,
    fullScansOnVar: fullVar,
    findRowById: findById,
    findRowBySecret: findSecret,
    appends: (b.match(/appendRowFromObject\(/g) || []).length,
    updates: (b.match(/updateRowFromObject\(/g) || []).length,
    setValues: (b.match(/\.setValue\(|\.setValues\(/g) || []).length,
    cached: /getCached\(/.test(b),
    invalidates: (b.match(/invalidateCache\(/g) || []).length,
    lock: /LockService/.test(b),
    mail: (b.match(/MailApp|GmailApp|sendAppEmail\(/g) || []).length,
    drive: (b.match(/DriveApp|UrlFetchApp/g) || []).length
  };
}

const CALLEE = /\b(\w+)\s*\(/g;
function resolve(name, seen, depth) {
  const body = fns[name];
  if (!body || seen.has(name) || depth > 4) return null;
  seen.add(name);
  const own = directCosts(body);
  const agg = {
    fullScans: own.fullScans.slice(), findRowById: own.findRowById.slice(),
    findRowBySecret: own.findRowBySecret.slice(),
    fullScansOnVar: own.fullScansOnVar, appends: own.appends, updates: own.updates,
    setValues: own.setValues, cached: own.cached, invalidates: own.invalidates,
    lock: own.lock, mail: own.mail, drive: own.drive, via: []
  };
  const b = strip(body);
  let c;
  const seenCall = new Set();
  while ((c = CALLEE.exec(b))) {
    const callee = c[1];
    if (callee === name || seenCall.has(callee) || !fns[callee]) continue;
    seenCall.add(callee);
    const sub = resolve(callee, new Set(seen), depth + 1);
    if (!sub) continue;
    if (sub.fullScans.length || sub.findRowById.length || sub.appends || sub.updates) agg.via.push(callee);
    agg.fullScans.push(...sub.fullScans);
    agg.findRowById.push(...sub.findRowById);
    agg.findRowBySecret.push(...sub.findRowBySecret);
    agg.fullScansOnVar += sub.fullScansOnVar;
    agg.appends += sub.appends; agg.updates += sub.updates; agg.setValues += sub.setValues;
    agg.cached = agg.cached || sub.cached;
    agg.invalidates += sub.invalidates;
    agg.lock = agg.lock || sub.lock;
    agg.mail += sub.mail; agg.drive += sub.drive;
  }
  return agg;
}

// Only the actions the frontend actually calls.
const inv = JSON.parse(fs.readFileSync(REPO + 'performance-audit/data/inventory.json', 'utf8'));
const used = [...new Set(inv.apiCalls.map((c) => c.action))].sort();

const rows = [];
for (const action of used) {
  const fname = 'action' + action[0].toUpperCase() + action.slice(1);
  if (!fns[fname]) { rows.push({ action, fn: fname, missing: true }); continue; }
  const r = resolve(fname, new Set(), 0);
  const tabs = {};
  r.fullScans.forEach((t) => { tabs[t] = (tabs[t] || 0) + 1; });
  rows.push({
    action, fn: fname,
    fullScanCount: r.fullScans.length,
    fullScanTabs: tabs,
    fullScansOnVar: r.fullScansOnVar,
    indexedLookups: r.findRowById.length + r.findRowBySecret.length,
    writes: r.appends + r.updates + r.setValues,
    cached: r.cached, invalidates: r.invalidates, lock: r.lock,
    mail: r.mail, drive: r.drive, via: [...new Set(r.via)]
  });
}

fs.writeFileSync(REPO + 'performance-audit/data/appsscript.json', JSON.stringify({ rows, used }, null, 2));

const initial = new Set(['getHomePageData', 'listProducts', 'listStores', 'searchProducts',
  'getStorePublicInfo', 'listTips', 'getCustomerInbox', 'listCustomerOrders',
  'listCustomerBookings', 'getCustomerProfile', 'getProductReviews', 'recordProductViews',
  'recordStoreVisit', 'getConversation']);

console.log('=== FULL-TAB READS PER ACTION (static analysis of real .gs source) ===');
console.log('Each "full scan" = sheetToObjects(getSheet(tab)) = every row of that tab into memory.\n');
console.log('action'.padEnd(26) + 'scans  idx  wr  cache lock  tabs scanned');
const sorted = rows.filter((r) => !r.missing).sort((a, b) => b.fullScanCount - a.fullScanCount);
for (const r of sorted) {
  console.log(r.action.padEnd(26) + String(r.fullScanCount).padStart(5) +
    String(r.indexedLookups).padStart(5) + String(r.writes).padStart(4) +
    (r.cached ? '  yes ' : '   no ') + (r.lock ? ' yes ' : '  no ') + ' ' +
    Object.entries(r.fullScanTabs).map(([t, n]) => n > 1 ? `${t}x${n}` : t).join(' '));
}
const missing = rows.filter((r) => r.missing);
if (missing.length) console.log('\nnot resolved to an action* function: ' + missing.map((r) => r.action).join(', '));

console.log('\n=== ACTIONS ON THE INITIAL-LOAD PATH ===');
for (const r of sorted.filter((x) => initial.has(x.action))) {
  console.log(`${r.action.padEnd(24)} ${String(r.fullScanCount).padStart(2)} full scans  cached=${r.cached}  tabs: ${Object.keys(r.fullScanTabs).join(', ') || 'none'}`);
}
