const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // --- §12 the way in to an account, from the homepage ---
  //
  // Twice repointed since this suite was written: first from owner/login.html
  // to the customer login (§13/§14), and now out of the header nav row into
  // the header overflow menu, which replaced that row. The claim is the same
  // one it always was - the homepage offers a way in, it is below Create
  // Store, it goes to the customer login, and it does not look like a lesser
  // link than the one above it.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForSelector('#header-menu-btn');
  const link = await p.evaluate(() => {
    const links = [...document.querySelectorAll('#header-menu-panel .header-menu-item')];
    const label = (a) => a.querySelector('.header-menu-label').textContent.trim();
    const create = links.find((a) => /Create Store/i.test(label(a)));
    const signin = links.find((a) => /My Account/i.test(label(a)));
    if (!signin || !create) return { signin: false };
    const cs = getComputedStyle(signin), cc = getComputedStyle(create);
    const order = create.compareDocumentPosition(signin) & Node.DOCUMENT_POSITION_FOLLOWING;
    return {
      signin: true,
      href: signin.getAttribute('href'),
      below: !!order,
      sameColor: cs.color === cc.color,
      sameSize: cs.fontSize === cc.fontSize,
      sameWeight: cs.fontWeight === cc.fontWeight,
    };
  });
  ok('§12 account link exists', link.signin);
  ok('§12 account link is beneath Create Store', link.below);
  ok('§12 account link routes to login', link.href === 'customer-login.html', link.href);
  ok('§12 account link matches Create Store styling', link.sameColor && link.sameSize && link.sameWeight, JSON.stringify(link));
  await ctx.close();

  // --- §21 chat full-screen on mobile, windowed on desktop ---
  async function chatRect(width) {
    const c = await browser.newContext({ viewport: { width, height: 800 } });
    await c.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, storeName: 'Bong', products: [] }) }));
    const pg = await c.newPage();
    await pg.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
    await pg.waitForSelector('#chat-window', { state: 'attached' });
    await pg.evaluate(() => document.getElementById('chat-window').classList.add('chat-window--open'));
    await pg.waitForTimeout(320); // let the open transition settle
    const r = await pg.evaluate(() => {
      const win = document.getElementById('chat-window');
      const rect = win.getBoundingClientRect();
      const cs = getComputedStyle(win);
      return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left), radius: cs.borderTopLeftRadius };
    });
    await c.close();
    return r;
  }
  const mob = await chatRect(390);
  const desk = await chatRect(900);
  ok('§21 mobile chat is full width', mob.w === 390, JSON.stringify(mob));
  ok('§21 mobile chat is full height', mob.h >= 780, JSON.stringify(mob));
  ok('§21 mobile chat anchored top-left', mob.top === 0 && mob.left === 0, JSON.stringify(mob));
  ok('§21 mobile chat has no rounded corners', mob.radius === '0px', mob.radius);
  ok('§21 desktop chat stays windowed (~360px, not full)', desk.w <= 380 && desk.w < 900, JSON.stringify(desk));
  ok('§21 desktop chat keeps rounded corners', desk.radius !== '0px', desk.radius);

  await browser.close();
  let failed = 0;
  console.log('\n--- Account link (§12) + mobile full-screen chat (§21) ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
