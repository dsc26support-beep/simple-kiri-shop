const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://127.0.0.1:8099';
const APPS_SCRIPT = 'https://script.google.com/macros/s/FAKE/exec';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const results = [];
  const ok = (name, cond, extra) => { results.push([cond ? 'PASS' : 'FAIL', name, extra || '']); };

  // Track whether the SW ever intercepts a request to the Apps Script origin.
  // We mock that origin so the page's own fetches don't hang; if the SW obeyed
  // its cross-origin bypass, these still go over the (mocked) network.
  let appsScriptHits = 0;
  await ctx.route('**/macros/s/**', (route) => {
    appsScriptHits++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) });
  });

  // 1) manifest present + valid
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
  ok('index has <link rel=manifest>', !!manifestHref, manifestHref || '');
  const manifest = await page.evaluate(async (href) => {
    const r = await fetch(href);
    return r.ok ? await r.json() : null;
  }, manifestHref);
  ok('manifest.json fetches + parses', !!manifest);
  ok('manifest display=standalone', manifest && manifest.display === 'standalone');
  ok('manifest has 192 + 512 icons', manifest && manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
  ok('manifest has maskable icon', manifest && manifest.icons.some(i => i.purpose === 'maskable'));
  ok('theme-color meta present', await page.getAttribute('meta[name="theme-color"]', 'content') === '#332d63');
  ok('apple-touch-icon present', !!(await page.getAttribute('link[rel="apple-touch-icon"]', 'href')));

  // 2) SW registers and takes control
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready, null, { timeout: 10000 }).catch(() => {});
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r ? (r.active ? 'active' : (r.installing ? 'installing' : 'waiting')) : 'none';
  });
  ok('service worker registered', reg !== 'none', 'state=' + reg);

  // Reload so the SW controls the page
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  ok('page controlled by SW after reload', controlled);

  // 3) Icons load (192 + apple-touch + maskable)
  const iconChecks = await page.evaluate(async () => {
    const urls = ['assets/img/app-icon-192.png', 'assets/img/app-icon-maskable-512.png', 'assets/img/apple-touch-icon-180.png', 'assets/img/app-icon-android-512.png'];
    const out = {};
    for (const u of urls) { const r = await fetch(u); out[u] = r.status; }
    return out;
  });
  ok('all icon files serve 200', Object.values(iconChecks).every(s => s === 200), JSON.stringify(iconChecks));

  // 4) offline.html renders standalone
  const off = await ctx.newPage();
  const offResp = await off.goto(BASE + '/offline.html', { waitUntil: 'load' });
  const offText = await off.textContent('h1');
  ok('offline.html serves + renders', offResp.status() === 200 && /offline/i.test(offText), offText);
  await off.close();

  // 5) owner page (nested depth) registers SW at the site-root path
  const owner = await ctx.newPage();
  await owner.goto(BASE + '/owner/login.html', { waitUntil: 'load' });
  await owner.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready, null, { timeout: 10000 }).catch(() => {});
  const ownerSw = await owner.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r ? r.scope : 'none';
  });
  ok('owner page SW scope is site root (not /owner/)', ownerSw !== 'none' && !/\/owner\/$/.test(ownerSw), ownerSw);
  await owner.close();

  // 6) Apps Script origin was reached over the network (SW did NOT swallow it)
  ok('Apps Script requests hit the network (SW bypassed cross-origin)', appsScriptHits > 0, 'hits=' + appsScriptHits);

  await browser.close();

  console.log('\n--- PWA verification ---');
  let failed = 0;
  for (const [st, name, extra] of results) {
    if (st === 'FAIL') failed++;
    console.log(`${st}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
