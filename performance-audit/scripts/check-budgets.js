#!/usr/bin/env node
/**
 * Deterministic performance-budget gate (the PRIMARY gate).
 *
 * No browser, no network, no timing — so it never flakes. It measures the
 * bytes a page actually ships on a FIRST visit: the HTML plus every local
 * CSS/JS file it references, each gzipped the way GitHub Pages serves them.
 * That is the real load-time lever this whole audit identified (bytes, not
 * backend time — see MWAKETE_V1_PERFORMANCE_AUDIT.md / docs/V2_BASELINE.md).
 *
 * It fails ONLY on a real budget breach, with a clear message naming the page
 * or asset, the budget, the measured value, and the overage. Budgets live in
 * performance-audit/budgets.json and were set from measured numbers + headroom.
 *
 * Usage:
 *   node performance-audit/scripts/check-budgets.js            # gate: exit 1 on breach
 *   node performance-audit/scripts/check-budgets.js --report   # print current, never fail
 *   node performance-audit/scripts/check-budgets.js --json     # machine-readable, never fail
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const BUDGETS = path.join(ROOT, 'performance-audit', 'budgets.json');
const MODE = process.argv.includes('--json') ? 'json'
  : process.argv.includes('--report') ? 'report' : 'gate';

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
function gzipFile(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  return gz(fs.readFileSync(f));
}

// Local CSS/JS a page references (relative src/href only — CDN URLs are counted
// as 0 bytes here because they are not ours to budget; the CSP test guards which
// external hosts are even allowed).
function refsOf(htmlRel) {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), 'utf8');
  const dir = path.dirname(htmlRel);
  const out = [];
  const re = /(?:src|href)\s*=\s*"([^"]+\.(?:css|js))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (/^https?:|^\/\//i.test(url)) continue;         // external — not budgeted here
    const rel = path.normalize(path.join(url.startsWith('/') ? '.' : dir, url));
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

// Web fonts a page would pull (budget says zero). Matches Google Fonts / any
// stylesheet or preload that is a font, and @font-face external src in CSS.
function fontRefs(htmlRel) {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), 'utf8');
  const hits = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|\.woff2?|\.ttf|\.otf|as=["']font["']/i.test(tag)) hits.push(tag.slice(0, 80));
  }
  return hits;
}

function measurePage(htmlRel) {
  const htmlGzip = gzipFile(htmlRel) || 0;
  const refs = refsOf(htmlRel);
  let css = 0, js = 0; const missing = [];
  for (const r of refs) {
    const b = gzipFile(r);
    if (b === null) { missing.push(r); continue; }
    if (r.endsWith('.css')) css += b; else js += b;
  }
  return {
    page: htmlRel, htmlGzip, cssGzip: css, jsGzip: js,
    totalGzip: htmlGzip + css + js,
    requests: 1 + refs.length,          // HTML + each local asset
    fonts: fontRefs(htmlRel).length, missing
  };
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(BUDGETS, 'utf8'));
  const assetRows = Object.entries(cfg.assets || {}).map(([rel, budget]) => {
    const g = gzipFile(rel);
    return { rel, gzip: g, budget, over: g === null ? false : g > budget, missing: g === null };
  });
  const pageRows = Object.keys(cfg.pages || {}).map((p) => {
    const m = measurePage(p); const b = cfg.pages[p];
    m.budget = b;
    m.breaches = [];
    if (b.maxTotalGzip && m.totalGzip > b.maxTotalGzip) m.breaches.push(['total gzip', m.totalGzip, b.maxTotalGzip]);
    if (b.maxInitialJsGzip && m.jsGzip > b.maxInitialJsGzip) m.breaches.push(['initial JS gzip', m.jsGzip, b.maxInitialJsGzip]);
    if (b.maxRequests && m.requests > b.maxRequests) m.breaches.push(['static requests', m.requests, b.maxRequests]);
    if (cfg.fontsMustBeZero && m.fonts > 0) m.breaches.push(['web fonts', m.fonts, 0]);
    return m;
  });

  if (MODE === 'json') { console.log(JSON.stringify({ assets: assetRows, pages: pageRows }, null, 2)); return 0; }

  const kb = (n) => (n / 1024).toFixed(1) + 'K';
  console.log('\nAsset gzip budgets (what every page loads):');
  console.log('  ' + 'asset'.padEnd(34) + 'gzip'.padStart(8) + 'budget'.padStart(9) + '  status');
  for (const a of assetRows) {
    const status = a.missing ? 'MISSING' : a.over ? `OVER by ${kb(a.gzip - a.budget)}` : 'ok';
    console.log('  ' + a.rel.replace('assets/', '').padEnd(34) +
      (a.missing ? '-' : kb(a.gzip)).padStart(8) + kb(a.budget).padStart(9) + '  ' + status);
  }
  console.log('\nPer-page first-visit static transfer (HTML + local CSS/JS, gzipped):');
  console.log('  ' + 'page'.padEnd(26) + 'html'.padStart(7) + 'css'.padStart(8) + 'js'.padStart(8) +
    'total'.padStart(8) + 'budget'.padStart(8) + 'req'.padStart(5) + 'fonts'.padStart(6) + '  status');
  for (const p of pageRows) {
    const status = p.missing.length ? 'MISSING ' + p.missing.join(',') : p.breaches.length
      ? p.breaches.map((b) => `${b[0]} ${b[0].includes('gzip') ? kb(b[1]) + '>' + kb(b[2]) : b[1] + '>' + b[2]}`).join('; ') : 'ok';
    console.log('  ' + p.page.replace('.html', '').padEnd(26) +
      kb(p.htmlGzip).padStart(7) + kb(p.cssGzip).padStart(8) + kb(p.jsGzip).padStart(8) +
      kb(p.totalGzip).padStart(8) + (p.budget.maxTotalGzip ? kb(p.budget.maxTotalGzip) : '-').padStart(8) +
      String(p.requests).padStart(5) + String(p.fonts).padStart(6) + '  ' + status);
  }

  const assetBreaches = assetRows.filter((a) => a.over || a.missing);
  const pageBreaches = pageRows.filter((p) => p.breaches.length || p.missing.length);
  const failed = assetBreaches.length + pageBreaches.length;

  if (MODE === 'report') {
    console.log(`\n[report] ${failed} would breach. (report mode never fails)`);
    return 0;
  }
  if (failed) {
    console.log(`\n❌ PERFORMANCE BUDGET BREACH — ${failed} item(s) over budget.`);
    console.log('   If the growth is intended, raise the specific budget in performance-audit/budgets.json');
    console.log('   in the same PR, with a one-line reason. Budgets are measured + headroom, not arbitrary.');
    return 1;
  }
  console.log('\n✅ All performance budgets met.');
  return 0;
}

process.exit(main());
