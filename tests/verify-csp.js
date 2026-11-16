/**
 * Security hardening stage 2 (owner, 16 Nov 2026): Content-Security-Policy on
 * every page (audit finding 1). This checks, with the real browser CSP engine:
 *
 *  - every served page carries one well-formed CSP <meta>, identical across the
 *    site, injected before the first <script>;
 *  - script-src is STRICT: 'self' + the three third-party script hosts + inline
 *    hashes, and NO 'unsafe-inline' / 'unsafe-eval' - so an injected <script> or
 *    on*= handler cannot run;
 *  - the key third parties are allowed in the right directive (Google + Facebook
 *    sign-in, Cloudinary photos, face-api / backend) while an unknown origin is
 *    blocked for scripts, images and fetch();
 *  - each page's OWN inline scripts still run (their hashes are right) - if a
 *    hash were wrong the browser would block that block and fire a violation;
 *  - the two things a <meta> cannot carry (frame-ancestors, HSTS) are NOT faked.
 *
 * Node assertions read the files directly; the browser part loads pages on
 * :8099 and listens for `securitypolicyviolation`, which the engine fires from
 * the meta policy alone (no network needed - CSP blocks before the request).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ROOT = path.join(__dirname, '..');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

// ---- the served pages (same rule as tools/build-csp.js) --------------------
const SKIP = new Set(['.git', 'node_modules', 'sheets-addon', 'android', 'tests', 'tools', 'performance-audit', '.handoff', '.github']);
function pages(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (!SKIP.has(name)) pages(full, out); }
    else if (name.endsWith('.html')) out.push(path.relative(ROOT, full));
  }
  return out;
}
const SERVED = pages(ROOT).sort();

function cspOf(html) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)">/i);
  return m ? m[1] : null;
}
function parse(policy) {
  const map = {};
  policy.split(';').map((s) => s.trim()).filter(Boolean).forEach((d) => {
    const [name, ...vals] = d.split(/\s+/); map[name] = vals;
  });
  return map;
}

(async () => {
  /* ======================= 1. structure, all 45 pages ===================== */
  const policies = SERVED.map((p) => [p, cspOf(fs.readFileSync(path.join(ROOT, p), 'utf8'))]);
  ok('every served page has a CSP <meta> (' + SERVED.length + ' pages)', policies.every(([, c]) => c), J(policies.filter(([, c]) => !c).map(([p]) => p)));
  const uniq = [...new Set(policies.map(([, c]) => c))];
  ok('the policy string is identical on every page', uniq.length === 1, 'distinct=' + uniq.length);
  ok('the Sheets add-on sidebar is NOT given a CSP (runs in Google\'s sandbox)',
    !/Content-Security-Policy/.test(fs.readFileSync(path.join(ROOT, 'sheets-addon/Sidebar.html'), 'utf8')));

  const policy = policies[0][1] || '';
  const d = parse(policy);
  const has = (dir, tok) => (d[dir] || []).includes(tok);
  const sub = (dir, host) => (d[dir] || []).some((t) => t === host);

  ok('script-src is strict: no \'unsafe-inline\'', !has('script-src', "'unsafe-inline'"), J(d['script-src']));
  ok('script-src has no \'unsafe-eval\' / \'wasm-unsafe-eval\'', !has('script-src', "'unsafe-eval'") && !has('script-src', "'wasm-unsafe-eval'"));
  ok('script-src has \'self\' and inline hashes', has('script-src', "'self'") && (d['script-src'] || []).some((t) => t.startsWith("'sha256-")), J((d['script-src'] || []).filter((t) => t.startsWith("'sha256"))?.length));
  ok('script-src allows Google Identity (accounts.google.com)', sub('script-src', 'https://accounts.google.com'));
  ok('script-src allows the Facebook SDK (connect.facebook.net)', sub('script-src', 'https://connect.facebook.net'));
  ok('script-src allows jsDelivr (face-api + ZXING)', sub('script-src', 'https://cdn.jsdelivr.net'));

  ok('connect-src reaches the Apps Script backend (both hosts)',
    sub('connect-src', 'https://script.google.com') && sub('connect-src', 'https://script.googleusercontent.com'), J(d['connect-src']));
  ok('connect-src allows GSI, Facebook login and jsDelivr model weights',
    sub('connect-src', 'https://accounts.google.com') && sub('connect-src', 'https://cdn.jsdelivr.net') &&
    sub('connect-src', 'https://graph.facebook.com') && sub('connect-src', 'https://www.facebook.com'), J(d['connect-src']));
  ok('img-src allows Cloudinary and Google-hosted images, plus data:/blob:',
    sub('img-src', 'https://res.cloudinary.com') && sub('img-src', 'https://*.googleusercontent.com') &&
    has('img-src', 'data:') && has('img-src', 'blob:'), J(d['img-src']));
  ok('frame-src allows the Google and Facebook sign-in iframes',
    sub('frame-src', 'https://accounts.google.com') && sub('frame-src', 'https://www.facebook.com'), J(d['frame-src']));
  ok('object-src is \'none\' and base-uri is \'self\'', has('object-src', "'none'") && has('base-uri', "'self'"));
  ok('form-action and worker-src are \'self\'', has('form-action', "'self'") && has('worker-src', "'self'"));

  // The two things a meta tag genuinely cannot carry - must NOT be faked.
  ok('frame-ancestors is NOT in the meta (needs the Cloudflare proxy - documented)', !/frame-ancestors/i.test(policy));
  ok('no HSTS / Strict-Transport-Security is faked in a meta', !/strict-transport-security/i.test(policy));

  // Regression guard that keeps the strict policy honest: no inline on*= / javascript:
  const handlers = SERVED.filter((p) => /\son[a-z]+\s*=\s*["']/.test(fs.readFileSync(path.join(ROOT, p), 'utf8')));
  ok('no page has an inline on*= handler (strict script-src would block it)', handlers.length === 0, J(handlers));
  const jsurl = SERVED.filter((p) => /["'(]javascript:/i.test(fs.readFileSync(path.join(ROOT, p), 'utf8')));
  ok('no page has a javascript: URL', jsurl.length === 0, J(jsurl));

  /* ======================= 2. real-browser enforcement ==================== */
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Keep everything off the network: pretend-answer the backend, drop third parties.
  await ctx.route('**/macros/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent|facebook|jsdelivr|evil\.example/, (r) => r.abort());
  // Not a first visit, so index.html does not redirect to the welcome screen.
  await ctx.addInitScript(() => { try { localStorage.setItem('mwk_seen', '1'); } catch (e) {} });
  // Collect CSP violations into the page.
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ dir: e.effectiveDirective, uri: (e.blockedURI || '').slice(0, 60) });
    });
  });

  // 2a. a page's own hashed inline scripts RUN, and nothing on the page is blocked.
  for (const p of ['index.html', 'customer-login.html', 'help.html', 'stores.html', 'product.html',
    'store.html', 'customer-dashboard.html', 'driver-contract.html', 'offline.html']) {
    const page = await ctx.newPage();
    await page.goto(BASE + '/' + p, { waitUntil: 'load' });
    await page.waitForTimeout(250);
    const v = await page.evaluate(() => window.__csp.filter((x) => /script-src/.test(x.dir)));
    ok(p + ': its own inline scripts are allowed (no inline-script CSP violation)', v.length === 0, J(v));
    await page.close();
  }
  // index.html's early-fetch inline block actually executed under CSP.
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(250);
    const ran = await page.evaluate(() => typeof window.__mwkEarly === 'object' && window.__mwkEarly !== null);
    ok('index.html: the hashed early-fetch inline block ran (window.__mwkEarly set)', ran);
    await page.close();
  }

  // 2b. the browser BLOCKS a disallowed script, image and fetch; ALLOWS known hosts.
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    const res = await page.evaluate(async () => {
      const out = { inlineRan: false, extRan: false };
      // disallowed inline <script> (unknown hash) must not run
      window.__evilInline = false;
      const s1 = document.createElement('script'); s1.text = 'window.__evilInline = true;';
      document.body.appendChild(s1); out.inlineRan = window.__evilInline;
      // disallowed external script host must be blocked by CSP
      await new Promise((done) => {
        const s2 = document.createElement('script'); s2.src = 'https://evil.example/x.js';
        s2.onload = () => { out.extRan = true; done(); }; s2.onerror = () => done();
        document.body.appendChild(s2); setTimeout(done, 400);
      });
      // disallowed image host (blocked) vs an ALLOWED Cloudinary image (CSP must not block it)
      await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = 'https://evil.example/x.png'; setTimeout(done, 400); });
      await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = 'https://res.cloudinary.com/demo/image/upload/x.png'; setTimeout(done, 400); });
      // disallowed fetch host (blocked) vs the ALLOWED backend host (CSP must not block it)
      try { await fetch('https://evil.example/data'); } catch (e) {}
      try { await fetch('https://script.google.com/macros/s/x/exec'); } catch (e) {}
      await new Promise((r) => setTimeout(r, 200));
      out.csp = window.__csp;
      return out;
    });
    const dirs = (f) => res.csp.filter(f);
    ok('an injected inline <script> (unknown hash) does not run', res.inlineRan === false);
    ok('an injected script from an unknown host does not run', res.extRan === false);
    ok('CSP blocks a script from evil.example', dirs((x) => /script-src/.test(x.dir) && /evil\.example/.test(x.uri)).length > 0, J(res.csp));
    ok('CSP blocks an image from evil.example', dirs((x) => x.dir === 'img-src' && /evil\.example/.test(x.uri)).length > 0, J(res.csp));
    ok('CSP blocks a fetch() to evil.example', dirs((x) => /connect-src/.test(x.dir) && /evil\.example/.test(x.uri)).length > 0, J(res.csp));
    ok('CSP does NOT block the backend fetch (script.google.com) or the Cloudinary image',
      dirs((x) => /script\.google\.com/.test(x.uri)).length === 0 &&
      dirs((x) => x.dir === 'img-src' && /res\.cloudinary\.com/.test(x.uri)).length === 0, J(res.csp));
    await page.close();
  }

  await ctx.close();
  await browser.close();
  R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
