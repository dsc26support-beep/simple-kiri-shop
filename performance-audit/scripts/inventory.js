// Static inventory of the V1 tree. Reads only; writes its output to
// performance-audit/data/. Touches no production file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const REPO = '/home/user/simple-kiri-shop/';

const SKIP = new Set(['.git', 'node_modules', 'performance-audit', '.github']);
const files = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, r);
    else files.push({ path: r, bytes: fs.statSync(full).size });
  }
})(REPO, '');

const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
const KIND = { html: 'HTML', css: 'CSS', js: 'JS', gs: 'AppsScript', svg: 'Image',
  png: 'Image', jpg: 'Image', jpeg: 'Image', webp: 'Image', ico: 'Image',
  json: 'Config', md: 'Docs', txt: 'Docs', xml: 'Config', csv: 'Data', docx: 'Docs' };

for (const f of files) {
  f.kind = KIND[extOf(f.path)] || 'Other';
  if (['HTML', 'CSS', 'JS', 'AppsScript'].includes(f.kind) || extOf(f.path) === 'svg') {
    f.gzip = zlib.gzipSync(fs.readFileSync(REPO + f.path)).length;
  } else {
    f.gzip = null;
  }
}

// What each HTML page actually pulls in.
const pages = files.filter((f) => f.kind === 'HTML').map((f) => {
  const src = fs.readFileSync(REPO + f.path, 'utf8');
  const scripts = [...src.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...src.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const preconnects = [...src.matchAll(/<link[^>]*rel="preconnect"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const imgs = [...src.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const inlineScripts = (src.match(/<script(?![^>]*src=)/g) || []).length;
  const inlineStyles = (src.match(/<style/g) || []).length;
  const external = [...src.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const base = (p) => p.replace(/^(\.\.\/)+/, '');
  const jsBytes = scripts.reduce((n, s) => {
    const hit = files.find((x) => x.path === base(s));
    return n + (hit ? hit.bytes : 0);
  }, 0);
  const jsGzip = scripts.reduce((n, s) => {
    const hit = files.find((x) => x.path === base(s));
    return n + (hit && hit.gzip ? hit.gzip : 0);
  }, 0);
  return { page: f.path, htmlBytes: f.bytes, htmlGzip: f.gzip, scripts, scriptCount: scripts.length,
    jsBytes, jsGzip, styles, preconnects, imgs, inlineScripts, inlineStyles,
    externalRefs: [...new Set(external)] };
});

// Every API action name the frontend can send, and where from.
const jsFiles = files.filter((f) => f.kind === 'JS');
const apiCalls = [];
for (const f of jsFiles) {
  const src = fs.readFileSync(REPO + f.path, 'utf8');
  for (const m of src.matchAll(/Api\.(get|post)\(\s*'([^']+)'/g)) {
    apiCalls.push({ file: f.path, method: m[1], action: m[2] });
  }
}

// Third-party origins referenced anywhere in the shipped frontend.
const origins = {};
for (const f of files.filter((x) => ['HTML', 'CSS', 'JS'].includes(x.kind))) {
  const src = fs.readFileSync(REPO + f.path, 'utf8');
  for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase();
    origins[host] = origins[host] || { host, files: new Set() };
    origins[host].files.add(f.path);
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  totals: {},
  files: files.sort((a, b) => b.bytes - a.bytes),
  pages,
  apiCalls,
  origins: Object.values(origins).map((o) => ({ host: o.host, referencedIn: [...o.files].sort() }))
    .sort((a, b) => a.host.localeCompare(b.host))
};

for (const k of ['HTML', 'CSS', 'JS', 'AppsScript', 'Image', 'Config', 'Docs', 'Data', 'Other']) {
  const set = files.filter((f) => f.kind === k);
  out.totals[k] = {
    count: set.length,
    bytes: set.reduce((n, f) => n + f.bytes, 0),
    gzip: set.reduce((n, f) => n + (f.gzip || 0), 0) || null
  };
}

fs.writeFileSync(REPO + 'performance-audit/data/inventory.json', JSON.stringify(out, null, 2));

console.log('=== FILE INVENTORY (production tree, audit folder excluded) ===');
for (const [k, v] of Object.entries(out.totals)) {
  if (!v.count) continue;
  console.log(`${k.padEnd(11)} ${String(v.count).padStart(3)} files  ${(v.bytes / 1024).toFixed(1).padStart(8)} KB raw` +
    (v.gzip ? `  ${(v.gzip / 1024).toFixed(1).padStart(7)} KB gzip` : ''));
}
console.log('\n=== PER-PAGE JS LOAD (what each page ships) ===');
console.log('page'.padEnd(30) + 'scripts  htmlKB   jsKB raw  jsKB gzip');
for (const p of pages.sort((a, b) => b.jsBytes - a.jsBytes)) {
  console.log(p.page.padEnd(30) + String(p.scriptCount).padStart(6) +
    (p.htmlBytes / 1024).toFixed(1).padStart(9) + (p.jsBytes / 1024).toFixed(1).padStart(11) +
    (p.jsGzip / 1024).toFixed(1).padStart(11));
}
console.log('\n=== THIRD-PARTY ORIGINS REFERENCED ===');
for (const o of out.origins) console.log(`${o.host.padEnd(34)} in ${o.referencedIn.length} file(s)`);
console.log('\n=== DISTINCT API ACTIONS CALLED BY THE FRONTEND ===');
const byAction = {};
apiCalls.forEach((c) => { byAction[c.action] = (byAction[c.action] || 0) + 1; });
console.log(Object.keys(byAction).length + ' distinct actions, ' + apiCalls.length + ' call sites');
