const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function newCtx(opts) {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    return ctx;
  }

  // 1. Mobile: button visible; sits above chat FAB on store.html
  {
    const ctx = await newCtx({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 }).catch(() => {});
    const visible = await page.$eval('.install-fab', el => getComputedStyle(el).display !== 'none').catch(() => false);
    ok('mobile home: install button visible', visible);
    const label = await page.$eval('.install-fab', el => el.textContent.trim()).catch(() => '');
    ok('button labelled Install', /Install/.test(label), label);
    await page.close();

    const sp = await ctx.newPage();
    await sp.goto(BASE + '/store.html?store=x', { waitUntil: 'load' });
    await sp.waitForSelector('.install-fab.is-visible', { timeout: 3000 }).catch(() => {});
    const geo = await sp.evaluate(() => {
      const f = document.querySelector('.install-fab').getBoundingClientRect();
      const c = document.querySelector('.chat-fab-btn').getBoundingClientRect();
      return { fabBottom: f.bottom, chatTop: c.top, fabRight: Math.round(innerWidth - f.right), chatRight: Math.round(innerWidth - c.right) };
    });
    ok('store: install sits ABOVE chat fab', geo.fabBottom <= geo.chatTop + 1, JSON.stringify(geo));
    ok('store: right-aligned like chat fab', Math.abs(geo.fabRight - geo.chatRight) <= 2, JSON.stringify(geo));
    await sp.close();
    await ctx.close();
  }

  // 2. Desktop: hidden
  {
    const ctx = await newCtx({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const disp = await page.$eval('.install-fab', el => getComputedStyle(el).display).catch(() => 'absent');
    ok('desktop: install button hidden', disp === 'none' || disp === 'absent', disp);
    await page.close();
    await ctx.close();
  }

  // 3. Native-prompt path: synthetic beforeinstallprompt, tap calls prompt() then hides
  {
    const ctx = await newCtx({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => {
      window.__promptCalled = 0;
      const e = new Event('beforeinstallprompt');
      e.prompt = () => { window.__promptCalled++; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    await page.click('.install-fab');
    await page.waitForTimeout(100);
    const called = await page.evaluate(() => window.__promptCalled);
    ok('native path: tap calls deferredPrompt.prompt()', called === 1, 'called=' + called);
    const hiddenAfter = await page.$eval('.install-fab', el => !el.classList.contains('is-visible'));
    ok('native path: button hides after accepted', hiddenAfter);
    await page.close();
    await ctx.close();
  }

  // 4. iOS path: instructions bubble, no prompt
  {
    const ctx = await newCtx(Object.assign({}, devices['iPhone 12']));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    await page.click('.install-fab');
    await page.waitForSelector('.install-hint', { timeout: 2000 });
    const hintText = await page.$eval('.install-hint', el => el.textContent);
    ok('iOS: shows Add-to-Home-Screen hint', /Share/.test(hintText) && /Add to Home Screen/.test(hintText), hintText);
    await page.close();
    await ctx.close();
  }

  // 5. Auto-hide after configured delay
  {
    const ctx = await newCtx({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { window.MWAKETE_INSTALL_HIDE_MS = 300; });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    await page.waitForTimeout(700);
    const gone = await page.$eval('.install-fab', el => !el.classList.contains('is-visible'));
    ok('auto-hide after ~configured delay', gone);
    await page.close();
    await ctx.close();
  }

  // 6. Every-load: reload shows it again
  {
    const ctx = await newCtx({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    await page.reload({ waitUntil: 'load' });
    const again = await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 }).then(() => true).catch(() => false);
    ok('reappears on reload', again);
    await page.close();
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- install button verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
