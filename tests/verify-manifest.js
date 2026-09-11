const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
  const m = await page.evaluate(async (href) => {
    const r = await fetch(href);
    return { url: new URL(href, location.href).href, json: await r.json() };
  }, manifestHref);

  ok('start_url is index.html', m.json.start_url === 'index.html', m.json.start_url);
  ok('id is "."', m.json.id === '.', String(m.json.id));
  ok('scope unchanged (".")', m.json.scope === '.', m.json.scope);

  // start_url must resolve to the home page URL
  const resolved = new URL(m.json.start_url, m.url).href;
  ok('start_url resolves to /index.html', resolved.endsWith('/index.html'), resolved);

  // and that URL is the Home page (Trending Products), not search
  const homeCheck = await page.evaluate(async (u) => {
    const r = await fetch(u);
    const t = await r.text();
    return { status: r.status, isHome: t.includes('Trending Products'), isSearch: t.includes('id="results-heading"') };
  }, resolved);
  ok('resolved start_url serves Home (200 + Trending Products)', homeCheck.status === 200 && homeCheck.isHome && !homeCheck.isSearch, JSON.stringify(homeCheck));

  await browser.close();
  console.log('\n--- manifest start_url verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
