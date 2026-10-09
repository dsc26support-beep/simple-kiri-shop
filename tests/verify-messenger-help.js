// Facebook Messenger box: new placeholder, "Help me find my profile name"
// link (new tab), and the messenger-help.html page with its link checker.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, owner: { ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', messenger: '' } }) }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });

  for (const [path, id] of [['/owner/login.html?tab=register', 'register-messenger'], ['/owner/settings.html', 'contact-messenger']]) {
    if (id === 'contact-messenger') await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    ok(`${path}: placeholder is "e.g. https://m.me/profilename"`, (await page.getAttribute('#' + id, 'placeholder')) === 'e.g. https://m.me/profilename');
    const help = await page.$eval(`#${id}-help`, (p) => ({ text: p.textContent.trim(), href: p.querySelector('a') && p.querySelector('a').getAttribute('href'),
      target: p.querySelector('a') && p.querySelector('a').target }));
    ok(`${path}: the long explanation is replaced by "Help me find my profile name"`, help.text === 'Help me find my profile name', help.text);
    ok(`${path}: it opens the help page in a new tab (the form keeps what was typed)`, help.href === '../messenger-help.html' && help.target === '_blank', JSON.stringify(help));
    ok(`${path}: the box is linked to the help text for screen readers`, (await page.getAttribute('#' + id, 'aria-describedby')) === id + '-help');
  }

  await page.goto(BASE + '/messenger-help.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const heads = await page.$$eval('main h2', (hs) => hs.map((h) => h.textContent.trim()));
  ok('help page: phone, computer, Page, check, and reaching people sections', ['On a phone (Facebook app)', 'On a computer', 'If you sell from a Facebook Page',
    'Check your link works', 'Reaching sellers and customers on Messenger'].every((h) => heads.includes(h)), heads.join(' | '));
  ok('help page: numbered steps', (await page.$$('.mh-steps li')).length >= 12);
  const check = async (v) => { await page.fill('#mh-input', v); await page.waitForTimeout(80); return page.textContent('#mh-result'); };
  ok('checker: a facebook.com link becomes the m.me link', /https:\/\/m\.me\/bong\.store/.test(await check('https://www.facebook.com/bong.store?ref=xyz')));
  ok('checker: an m.me link stays', /https:\/\/m\.me\/profilename/.test(await check('https://m.me/profilename')));
  ok('checker: a profile with only an id number works', /https:\/\/m\.me\/100012345678/.test(await check('https://www.facebook.com/profile.php?id=100012345678')));
  ok('checker: a plain name works', /https:\/\/m\.me\/teaube/.test(await check('teaube')));
  ok('checker: nonsense is explained, not saved', /doesn.t look like/.test(await check('facebook.com')) && (await page.$('#mh-result a')) === null);
  ok('checker: the link it shows opens in a new tab', await (async () => { await check('teaube'); return (await page.getAttribute('#mh-result a', 'target')) === '_blank'; })());
  ok('help page: no sideways scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (SHOT) await page.screenshot({ path: SHOT + '/messenger-help.png', fullPage: true });
  ok('no script errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  let f = 0;
  console.log('\n--- messenger help ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
