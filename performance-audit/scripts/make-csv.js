const fs = require('fs');
const REPO = '/home/user/simple-kiri-shop/';
const D = REPO + 'performance-audit/data/';
const gz = JSON.parse(fs.readFileSync(D + 'measurements-gzip.json', 'utf8'));
const plain = JSON.parse(fs.readFileSync(D + 'measurements.json', 'utf8'));
const rows = [];
const head = ['transport', 'page', 'profile', 'apiLatencyMs', 'cacheState', 'auth', 'fcpMs', 'lcpMs',
  'lcpElement', 'cls', 'ttfbLocalMs', 'domContentLoadedMs', 'loadEventMs', 'requests',
  'transferredBytes', 'decodedBytes', 'apiCalls', 'apiResponseBytes', 'scriptDurationMs',
  'layoutDurationMs', 'recalcStyleMs', 'taskDurationMs', 'longTasks', 'longTaskMs'];
const add = (transport, r) => rows.push([transport, r.page, r.profile, r.apiLatency,
  r.warm ? 'warm' : 'cold', r.loggedIn ? 'logged-in' : 'logged-out', r.fcp, r.lcp,
  r.lcpElement || '', r.cls, r.ttfbLocal, r.domContentLoaded, r.loadEvent, r.requests,
  r.transferred, r.decoded, r.apiCalls, r.apiBytes, r.scriptDurationMs, r.layoutDurationMs,
  r.recalcStyleMs, r.taskDurationMs, r.longTasks, r.longTaskMs]);
const after = JSON.parse(fs.readFileSync(D + 'measurements-after.json', 'utf8'));
gz.forEach((r) => add('BEFORE fixes - gzip (representative of GitHub Pages)', r));
after.forEach((r) => add('AFTER fixes - gzip (representative of GitHub Pages)', r));
plain.forEach((r) => add('BEFORE fixes - uncompressed (not representative)', r));
const csv = [head.join(',')].concat(rows.map((r) => r.map((v) =>
  typeof v === 'string' && /[,"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','))).join('\n');
fs.writeFileSync(REPO + 'MWAKETE_V1_PERFORMANCE_DATA.csv', csv + '\n');
console.log('rows: ' + rows.length);

// Handy aggregates for the report.
const g = (p, prof, lat, warm, auth) => gz.find((r) => r.page === p && r.profile === prof &&
  r.apiLatency === lat && !!r.warm === !!warm && !!r.loggedIn === !!auth);
const med = (p, prof) => { const s = gz.filter((r) => r.page === p && r.profile === prof && !r.warm && !r.loggedIn && r.apiLatency === 600).map((r) => r.fcp).sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
console.log('index mobile-4g FCP runs:', gz.filter(r=>r.page==='/index.html'&&r.profile==='mobile-4g'&&!r.warm&&!r.loggedIn&&r.apiLatency===600).map(r=>r.fcp).join(', '));
console.log('index slow3g:', JSON.stringify(g('/index.html','mobile-slow3g',600)&&{fcp:g('/index.html','mobile-slow3g',600).fcp,kb:Math.round(g('/index.html','mobile-slow3g',600).transferred/1024)}));
console.log('warm index:', JSON.stringify({fcp:g('/index.html','mobile-4g',600,true).fcp,kb:Math.round(g('/index.html','mobile-4g',600,true).transferred/1024)}));
