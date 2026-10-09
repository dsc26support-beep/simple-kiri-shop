// Store name field: stops at 22 characters with an n/22 counter (Create Store),
// and asks an older, longer name to be shortened before saving (Settings).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  let ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  let page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/owner/login.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const i = document.getElementById('register-store-name'); let el = i; while (el) { el.hidden = false; el.classList && el.classList.remove('hidden'); el = el.parentElement; } });
  await page.fill('#register-store-name', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const reg = await page.evaluate(() => ({ v: document.getElementById('register-store-name').value, c: document.getElementById('register-store-name-count').textContent }));
  ok('Create Store: typing stops at 22 characters', reg.v.length === 22, reg.v);
  ok('Create Store: shows the count n/22', reg.c === '22/22', reg.c);
  await ctx.close();

  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const longName = 'A Very Long Old Store Name Here';
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = (r.request().postDataJSON() || {}).action || ''; } catch (e) {}
    if (!a) a = new URL(r.request().url()).searchParams.get('action') || '';
    const owner = { ownerId: 'o1', storeName: longName, storeSlug: 's', status: 'active', email: 'a@x.com', phone: '73000001', island: 'South Tarawa', village: 'Bairiki' };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a === 'getOwnerProfile' ? { ok: true, owner } : { ok: true }) });
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const st = await page.evaluate(() => ({
    v: document.getElementById('store-name').value,
    c: (document.getElementById('store-name-count') || {}).textContent || '',
    over: !!document.querySelector('#store-name-count.is-over'),
    label: document.getElementById('store-name-label').textContent }));
  ok('Settings: an older long name is shown in full in the field', st.v === longName, st.v);
  ok('Settings: ...with a red note asking to shorten it', st.over && /31\/22 - please shorten/.test(st.c), st.c);
  ok('Settings: the header shows it cut to 22 with …', st.label === 'A Very Long Old Store…', st.label);
  ok('no JS errors', errs.length === 0, errs.join(' | '));
  await browser.close();
  let f = 0; console.log('\n--- store name field ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
