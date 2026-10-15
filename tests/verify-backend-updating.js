/**
 * When the website is live a few minutes before the matching Apps Script
 * deploy, the old backend answers "Unknown action: x". Shoppers must see a
 * plain "being updated" message instead (api.js), on GET and POST, while every
 * other error still reaches the page unchanged. Real pages, backend mocked as
 * the OLD deploy.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FRIENDLY = 'This part of Mwakete is being updated. Please try again in a little while.';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('skiri_customer_token', 'ctok');
    localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tia', email: 't@x.test', phone: '73000001' }));
    localStorage.setItem('skiri_cookie_consent', 'accepted');
  });
  // The old backend: knows nothing about drivers or the test actions.
  await ctx.route('**/macros/s/**', (route) => {
    const req = route.request();
    const action = req.postData() ? JSON.parse(req.postData()).action : new URL(req.url()).searchParams.get('action');
    const body = action === 'plainError' ? { ok: false, error: 'Not signed in' }
      : action === 'jobError' ? { ok: false, error: 'Unknown action.' }
      : action === 'fine' ? { ok: true, value: 1 }
      : { ok: false, error: 'Unknown action: ' + action };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(BASE + '/driver.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('drv-status').textContent.trim() !== '' && !/Loading/i.test(document.getElementById('drv-status').textContent), null, { timeout: 10000 }).catch(() => {});
  const status = (await p.textContent('#drv-status')).trim();
  ok('driver page on the old backend: a plain "being updated" message', status === FRIENDLY, status);
  ok('...no "Unknown action" shown anywhere on the page', !/Unknown action/.test(await p.textContent('body')));

  const r = await p.evaluate(async () => ({
    post: await Api.post('getDriverHome', {}),
    get: await Api.get('getNewThing', {}),
    plain: await Api.post('plainError', {}),
    job: await Api.post('jobError', {}),
    fine: await Api.post('fine', {})
  }));
  ok('POST: unknown action becomes the friendly message, marked outdated', r.post.ok === false && r.post.error === FRIENDLY && r.post.outdated === true, JSON.stringify(r.post));
  ok('GET: same', r.get.ok === false && r.get.error === FRIENDLY && r.get.outdated === true, JSON.stringify(r.get));
  ok('other errors are passed through unchanged', r.plain.error === 'Not signed in' && !r.plain.outdated);
  ok('"Unknown action." from inside a feature (not the router) is left alone', r.job.error === 'Unknown action.' && !r.job.outdated);
  ok('successful answers are untouched', r.fine.ok === true && r.fine.value === 1 && !('outdated' in r.fine));
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));

  await browser.close();
  let fails = 0;
  console.log('\n--- backend being updated (friendly message) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
