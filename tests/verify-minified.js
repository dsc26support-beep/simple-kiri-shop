/**
 * Guards the asset build (tools/build-assets.js) on three fronts.
 *
 * 1. FRESHNESS - `npm run build:check` re-minifies every source file and
 *    byte-compares against what is committed. This is the one that catches the
 *    real hazard of a committed build: someone edits styles.css, forgets to
 *    rebuild, and the site quietly keeps serving the old rules.
 *
 * 2. WIRING - every page must load the .min asset, never the source, and every
 *    .min file a page asks for must exist. A typo here 404s a stylesheet and
 *    the page renders unstyled.
 *
 * 3. EQUIVALENCE - the part that actually matters. Each page is rendered twice,
 *    once with the source CSS and once with the minified CSS swapped in at the
 *    network layer, and EVERY element's computed style is compared. A minifier
 *    that changed what a rule means shows up here as a differing property on a
 *    real element, which byte-comparing could never catch.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

// Properties worth comparing: everything that decides layout, box, type and
// colour. Comparing the full computed-style object would drown real differences
// in vendor noise.
const PROPS = ['display', 'position', 'width', 'height', 'margin-top', 'margin-right',
  'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'border-top-width', 'border-bottom-width', 'border-left-width',
  'border-right-width', 'border-radius', 'font-size', 'font-weight', 'font-family',
  'line-height', 'color', 'background-color', 'flex-direction', 'justify-content',
  'align-items', 'gap', 'grid-template-columns', 'text-align', 'opacity', 'visibility',
  'overflow-x', 'overflow-y', 'z-index', 'box-shadow', 'transform', 'top', 'left',
  'right', 'bottom', 'white-space', 'text-decoration-line', 'letter-spacing'];

const PAGES = ['/index.html', '/store.html?store=bong', '/product.html?store=bong&product=p0',
  '/categories.html', '/stores.html', '/cart.html?store=bong', '/customer-dashboard.html',
  '/customer-login.html', '/customer-messages.html', '/customer-tips.html', '/my-carts.html',
  '/owner/login.html', '/owner/dashboard.html', '/owner/products.html', '/owner/settings.html'];

const snapshot = (page) => page.evaluate((props) => {
  const out = [];
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const cs = getComputedStyle(els[i]);
    const rec = {};
    for (const p of props) rec[p] = cs.getPropertyValue(p);
    out.push(rec);
  }
  return out;
}, PROPS);

(async () => {
  // --- 1. freshness -------------------------------------------------------
  let buildClean = true, buildOut = '';
  try {
    buildOut = execFileSync('npm', ['run', '--silent', 'build:check'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    buildClean = false;
    buildOut = (err.stdout || '') + (err.stderr || '');
  }
  ok('committed .min files match their source', buildClean, buildClean ? buildOut.trim() : buildOut.trim().split('\n').slice(-4).join(' | '));

  // --- 2. wiring ----------------------------------------------------------
  const htmlFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(ROOT);

  const sourceRefs = [];
  const missing = [];
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    // A reference to a source asset that HAS a .min twin is a page that never
    // got switched over.
    for (const m of html.matchAll(/(?:src|href)="([^"]*assets\/(?:js|css)\/[^"]+\.(?:js|css))"/g)) {
      const ref = m[1];
      if (/\.min\.(js|css)$/.test(ref)) {
        const abs = path.resolve(path.dirname(f), ref);
        if (!fs.existsSync(abs)) missing.push(rel + ' -> ' + ref);
      } else {
        const twin = ref.replace(/\.(js|css)$/, '.min.$1');
        const abs = path.resolve(path.dirname(f), twin);
        if (fs.existsSync(abs)) sourceRefs.push(rel + ' -> ' + ref);
      }
    }
  }
  ok('no page loads a source asset that has a built twin', sourceRefs.length === 0,
    sourceRefs.length ? sourceRefs.slice(0, 6).join(' | ') : htmlFiles.length + ' pages checked');
  ok('every .min asset a page references exists', missing.length === 0,
    missing.length ? missing.slice(0, 6).join(' | ') : 'none missing');

  // --- 3. equivalence -----------------------------------------------------
  const minCss = fs.readFileSync(path.join(ROOT, 'assets/css/styles.min.css'), 'utf8');
  const minOwner = fs.readFileSync(path.join(ROOT, 'assets/css/owner.min.css'), 'utf8');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const p of PAGES) {
    const shots = [];
    for (const useMin of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.route('**/script.google.com/**', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, products: [], stores: [], tips: [] }) }));
      // Serve the OTHER stylesheet's bytes under whichever URL the page asks
      // for, so the only thing that differs between the two runs is the CSS.
      if (useMin) {
        await ctx.route('**/assets/css/styles*.css', (r) =>
          r.fulfill({ status: 200, contentType: 'text/css', body: minCss }));
        await ctx.route('**/assets/css/owner*.css', (r) =>
          r.fulfill({ status: 200, contentType: 'text/css', body: minOwner }));
      } else {
        await ctx.route('**/assets/css/styles*.css', (r) => r.fulfill({ status: 200,
          contentType: 'text/css', body: fs.readFileSync(path.join(ROOT, 'assets/css/styles.css'), 'utf8') }));
        await ctx.route('**/assets/css/owner*.css', (r) => r.fulfill({ status: 200,
          contentType: 'text/css', body: fs.readFileSync(path.join(ROOT, 'assets/css/owner.css'), 'utf8') }));
      }
      const page = await ctx.newPage();
      const isLogin = /login|forgot-password/.test(p);
      await page.addInitScript((seed) => {
        try {
          localStorage.setItem('skiri_cookie_consent', 'true');
          if (!seed.isLogin) {
            localStorage.setItem('skiri_owner_token', 't');
            localStorage.setItem('skiri_customer_token', 't');
          }
        } catch (e) {}
      }, { isLogin });
      await page.goto(BASE + p, { waitUntil: 'load' }).catch(() => {});
      await page.waitForTimeout(2200);
      shots.push(await snapshot(page));
      await ctx.close();
    }
    const [src, min] = shots;
    let diff = null;
    if (src.length !== min.length) {
      diff = 'element count ' + src.length + ' vs ' + min.length;
    } else {
      for (let i = 0; i < src.length && !diff; i++) {
        for (const prop of PROPS) {
          if (src[i][prop] !== min[i][prop]) {
            diff = 'el#' + i + ' ' + prop + ': "' + src[i][prop] + '" vs "' + min[i][prop] + '"';
            break;
          }
        }
      }
    }
    ok('computed styles identical, source vs minified: ' + p, diff === null,
      diff || src.length + ' elements x ' + PROPS.length + ' properties');
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
