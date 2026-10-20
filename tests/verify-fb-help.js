/**
 * "Help?" under the Facebook Messenger box on Register Store and Store
 * Settings (owner request, Oct 2026): opens "I am using..." with Mobile /
 * Tablet / PC, each opening Facebook's own Help Center article in a new tab
 * with that device's platform set. Keyboard: focus goes in, Tab stays in,
 * Escape closes and returns focus. Also: the App Install tab is now outlined
 * in yellow with a see-through fill. Backend mocked.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';
const ARTICLE = 'https://www.facebook.com/help/162586890471598?helpref=platform_switcher&cms_platform=';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (path, ua, owner) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: ua });
    await ctx.addInitScript((o) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (o) { localStorage.setItem('skiri_owner_token', 't'); localStorage.setItem('skiri_owner_profile', '{"storeName":"S","storeSlug":"s","status":"active"}'); }
    }, !!owner);
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, owner: { storeName: 'S', storeSlug: 's', status: 'active' }, products: [], stores: [] }) }));
    await ctx.route('https://www.facebook.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>FB help</title>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(path + ': ' + e));
    await p.goto(BASE + path, { waitUntil: 'load' });
    await p.waitForTimeout(600);
    return { ctx, p };
  };
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A146) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  for (const [label, path, owner, field] of [['Register Store', '/owner/login.html?tab=register', false, '#register-messenger-help'], ['Store Settings', '/owner/settings.html', true, '#contact-messenger-help']]) {
    const { ctx, p } = await open(path, ANDROID, owner);
    if (label === 'Register Store') await p.click('#tab-register').catch(() => {});
    const help = (await p.textContent(field)).trim();
    ok(`${label}: the old instruction is replaced by "Help?"`, help === 'Help?', help);
    ok(`${label}: the Messenger box still points at it for screen readers`, await p.evaluate((f) => !!document.querySelector(`[aria-describedby="${f.slice(1)}"]`), field));
    await p.click(field + ' [data-fb-help]');
    await p.waitForSelector('.fbh-box', { timeout: 3000 });
    const d = await p.evaluate(() => ({
      title: document.getElementById('fbh-title').textContent,
      opts: Array.from(document.querySelectorAll('.fbh-option')).map((a) => [a.dataset.device, a.textContent.replace(/↗|\(opens in a new tab\)/g, '').trim(), a.getAttribute('href'), a.target, a.rel]),
      focus: document.activeElement && document.activeElement.textContent.trim().replace(/↗.*$/, ''),
      modal: document.querySelector('.fbh-box').getAttribute('aria-modal')
    }));
    ok(`${label}: popup titled "I am using..."`, d.title === 'I am using...', d.title);
    ok(`${label}: three choices Mobile, Tablet, PC`, d.opts.map((o) => o[1]).join(',') === 'Mobile,Tablet,PC', JSON.stringify(d.opts.map((o) => o[1])));
    ok(`${label}: Android phone → Facebook help, Android / Android / computer`,
      d.opts[0][2] === ARTICLE + 'android-app' && d.opts[1][2] === ARTICLE + 'android-app' && d.opts[2][2] === ARTICLE + 'www', JSON.stringify(d.opts.map((o) => o[2])));
    ok(`${label}: each opens in a new tab, safely`, d.opts.every((o) => o[3] === '_blank' && /noopener/.test(o[4])));
    ok(`${label}: focus moves into the popup (Mobile)`, d.focus === 'Mobile', d.focus);
    if (SHOT && label === 'Register Store') await p.screenshot({ path: SHOT + '/fb-help-popup.png' });
    const [tab] = await Promise.all([ctx.waitForEvent('page'), p.click('.fbh-option[data-device="pc"]')]);
    ok(`${label}: tapping PC opens Facebook's help in a new tab`, tab.url() === ARTICLE + 'www', tab.url());
    await tab.close();
    await p.waitForTimeout(100);
    ok(`${label}: ...and the popup closes behind it`, !(await p.$('.fbh-box')));
    await p.click(field + ' [data-fb-help]');
    await p.keyboard.press('Shift+Tab');
    ok(`${label}: Tab stays inside the popup`, await p.evaluate(() => !!document.activeElement.closest('.fbh-box')));
    await p.keyboard.press('Escape');
    ok(`${label}: Escape closes it and returns focus to Help?`, !(await p.$('.fbh-box')) && await p.evaluate(() => document.activeElement.hasAttribute('data-fb-help')));
    await p.click(field + ' [data-fb-help]');
    await p.mouse.click(10, 10);
    ok(`${label}: tapping outside closes it`, !(await p.$('.fbh-box')));
    ok(`${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
    await ctx.close();
  }
  {
    const { ctx, p } = await open('/owner/login.html?tab=register', IPHONE, false);
    await p.click('#tab-register').catch(() => {});
    await p.click('#register-messenger-help [data-fb-help]');
    const hrefs = await p.$$eval('.fbh-option', (a) => a.map((x) => x.getAttribute('href')));
    ok('iPhone → iPhone app, iPad app, computer', hrefs[0] === ARTICLE + 'iphone-app' && hrefs[1] === ARTICLE + 'ipad-app' && hrefs[2] === ARTICLE + 'www', JSON.stringify(hrefs));
    await ctx.close();
  }

  /* App Install tab: yellow outline, see-through fill */
  {
    const { ctx, p } = await open('/index.html', ANDROID, false);
    await p.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
    await p.waitForSelector('.install-fab.is-visible', { timeout: 3000 });
    const st = await p.evaluate(() => { const c = getComputedStyle(document.querySelector('.install-fab'));
      return { bg: c.backgroundColor, top: c.borderTopColor, w: c.borderTopWidth, edge: c.borderLeftWidth, label: document.querySelector('.install-fab').textContent.trim() }; });
    ok('App Install: see-through fill', st.bg === 'rgba(0, 0, 0, 0)', st.bg);
    ok('App Install: outlined in Mwakete yellow, open on the screen edge', st.top === 'rgb(252, 209, 22)' && st.w === '2px' && st.edge === '0px', JSON.stringify(st));
    ok('App Install: still reads "App Install"', st.label === 'App Install');
    if (SHOT) await p.screenshot({ path: SHOT + '/install-outline.png', clip: { x: 0, y: 0, width: 390, height: 480 } });
    await ctx.close();
  }

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- Messenger "Help?" popup + outlined App Install ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
