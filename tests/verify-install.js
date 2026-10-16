const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // The button only shows when it can help: Chromium says the app is
  // installable (beforeinstallprompt), or it's iOS (register-sw.js). A test
  // browser never fires that event by itself, so the tests fire it, as
  // Chrome on Android would.
  const fireInstallable = (page) => page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => {};
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });

  async function newCtx(opts) {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    return ctx;
  }

  // 1. Mobile: the "App Install" tab - right edge, words rotated bottom to
  //    top, level with the homepage's Categories ... Recents row, floating
  //    there while the page scrolls; same height on other pages (Oct 2026).
  {
    const ctx = await newCtx({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok('mobile, browser not offering install: no button (it never nags)', !(await page.$('.install-fab.is-visible')));
    await fireInstallable(page);
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 }).catch(() => {});
    const visible = await page.$eval('.install-fab', el => getComputedStyle(el).display !== 'none').catch(() => false);
    ok('mobile home: install button visible', visible);
    const label = await page.$eval('.install-fab', el => el.textContent.trim()).catch(() => '');
    ok('tab reads "App Install", no arrow icon', label === 'App Install' && !(await page.$('.install-fab svg')), label);
    const home = await page.evaluate(() => {
      const f = document.querySelector('.install-fab'); const r = f.getBoundingClientRect();
      const q = document.querySelector('.quick-action-strip').getBoundingClientRect();
      return { right: Math.round(innerWidth - r.right), mid: r.top + r.height / 2, row: q.top + q.height / 2, tall: r.height > r.width,
        wm: getComputedStyle(f).writingMode, tf: getComputedStyle(f).transform };
    });
    ok('flush with the right edge, taller than wide', home.right === 0 && home.tall, JSON.stringify(home));
    ok('level with the Categories ... Recents row', Math.abs(home.mid - home.row) <= 2, JSON.stringify(home));
    // vertical-rl turned half a turn = reads bottom to top.
    ok('words rotated to read bottom to top', home.wm === 'vertical-rl' && /matrix\(-1, .*-1, 0, 0\)/.test(home.tf), JSON.stringify(home));
    await page.evaluate(() => { const s = document.createElement('div'); s.style.height = '3000px'; document.body.appendChild(s); window.scrollTo(0, 800); });
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => { const r = document.querySelector('.install-fab').getBoundingClientRect(); return r.top + r.height / 2; });
    ok('stays at that height on screen while scrolling', Math.abs(after - home.mid) <= 1, after + ' vs ' + home.mid);
    await page.close();

    const sp = await ctx.newPage();
    await sp.goto(BASE + '/store.html?store=x', { waitUntil: 'load' });
    await fireInstallable(sp);
    await sp.waitForSelector('.install-fab.is-visible', { timeout: 3000 }).catch(() => {});
    const geo = await sp.evaluate(() => {
      const f = document.querySelector('.install-fab').getBoundingClientRect();
      const c = document.querySelector('.chat-fab-btn').getBoundingClientRect();
      return { fabBottom: f.bottom, chatTop: c.top, fabRight: Math.round(innerWidth - f.right), mid: f.top + f.height / 2 };
    });
    ok('store: clear of the chat button', geo.fabBottom <= geo.chatTop - 8, JSON.stringify(geo));
    ok('store: same place as on the homepage (right edge, same height)', geo.fabRight === 0 && Math.abs(geo.mid - home.mid) <= 2, JSON.stringify(geo) + ' home ' + home.mid);
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
    await fireInstallable(page);
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
    await fireInstallable(page);
    await page.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    await page.reload({ waitUntil: 'load' });
    await fireInstallable(page); // Chrome fires it again on every load while installable
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
