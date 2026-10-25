/**
 * "Help?" for the Facebook Messenger box on Register Store and Store Settings
 * (owner requests, Oct 2026) - now inside the box at its right edge: pressing it shows one line,
 * "Open Messenger > Menu > Settings > Username, then enter
 * m.me/your-username", under the box; pressing again hides it. No popup. Also: the App Install tab is now outlined
 * in yellow with a see-through fill. Backend mocked.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (path, ua, owner) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: ua });
    await ctx.addInitScript((o) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (o) { localStorage.setItem('skiri_owner_token', 't'); localStorage.setItem('skiri_owner_profile', '{"storeName":"S","storeSlug":"s","status":"active"}'); }
      // Register Store is an application from a signed-in shopper (Oct 2026).
      else { localStorage.setItem('skiri_customer_token', 'c'); localStorage.setItem('skiri_customer_profile', '{"customerId":"c1","name":"T","email":"t@x.com","emailVerified":true}'); }
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

  const STEPS = 'Open Messenger > Menu > Settings > Username, then enter m.me/your-username';
  for (const [label, path, owner, field] of [['Register Store', '/owner/login.html?tab=register', false, '#register-messenger'], ['Store Settings', '/owner/settings.html', true, '#contact-messenger']]) {
    const { ctx, p } = await open(path, ANDROID, owner);
    if (label === 'Register Store') await p.click('#tab-register').catch(() => {});
    // `field` is the Messenger input; F is its .field wrapper (label, box, steps).
    const F = `.field:has(${field})`;
    const help = (await p.textContent(field + ' ~ .fbh-btn')).trim();
    ok(`${label}: just "Help?" until it is pressed`, help === 'Help?', help);
    ok(`${label}: Help? sits inside the Messenger box, at its right edge`, await p.evaluate((f) => { const i = document.querySelector(f).getBoundingClientRect(), b = document.querySelector(f + ' ~ .fbh-btn').getBoundingClientRect();
      return b.left > i.left + i.width / 2 && b.right <= i.right && i.right - b.right < 12 && b.top >= i.top && b.bottom <= i.bottom; }, field));
    ok(`${label}: placeholder e.g. https://m.me/username`, (await p.getAttribute(field, 'placeholder')) === 'e.g. https://m.me/username');
    ok(`${label}: Help? says it is closed`, (await p.getAttribute(F + ' [data-fb-help]', 'aria-expanded')) === 'false');
    await p.click(F + ' [data-fb-help]');
    const line = await p.evaluate((f) => { const el = document.querySelector(`.field:has(${f}) .fbh-steps`); return el && !el.hidden ? el.textContent : null; }, field);
    ok(`${label}: pressing Help? shows the steps in one line`, line === STEPS, line);
    ok(`${label}: no popup, nothing leaves the page`, !(await p.$('.fbh-back, .fbh-box, [role="dialog"]')) && ctx.pages().length === 1);
    ok(`${label}: Help? now says it is open, and which line it controls`, (await p.getAttribute(F + ' [data-fb-help]', 'aria-expanded')) === 'true'
      && (await p.getAttribute(F + ' [data-fb-help]', 'aria-controls')) === field.slice(1) + '-steps');
    if (SHOT && label === 'Register Store') await p.screenshot({ path: SHOT + '/fb-help-line.png' });
    await p.click(F + ' [data-fb-help]');
    ok(`${label}: pressing it again hides the line`, await p.evaluate((f) => document.querySelector(`.field:has(${f}) .fbh-steps`).hidden, field)
      && (await p.getAttribute(F + ' [data-fb-help]', 'aria-expanded')) === 'false');
    await p.focus(F + ' [data-fb-help]');
    await p.keyboard.press('Enter');
    ok(`${label}: works from the keyboard too`, await p.evaluate((f) => !document.querySelector(`.field:has(${f}) .fbh-steps`).hidden, field));
    ok(`${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
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
  console.log('\n--- Messenger "Help?" steps + outlined App Install ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
