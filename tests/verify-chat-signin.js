const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // --- §12 Sign In link on homepage ---
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  const link = await p.evaluate(() => {
    const links = [...document.querySelectorAll('.site-nav a')];
    const create = links.find(a => /Create Store/i.test(a.textContent));
    const signin = links.find(a => /Sign In/i.test(a.textContent));
    if (!signin) return { signin: false };
    const cs = getComputedStyle(signin), cc = getComputedStyle(create);
    // Sign In should sit after Create Store in the list
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
  ok('§12 Sign In link exists', link.signin);
  ok('§12 Sign In is beneath Create Store', link.below);
  // Was owner/login.html when this suite was written; the customer-accounts
  // work (§13/§14) repointed the homepage Sign In at the customer login.
  ok('§12 Sign In routes to login', link.href === 'customer-login.html', link.href);
  ok('§12 Sign In matches Create Store styling', link.sameColor && link.sameSize && link.sameWeight, JSON.stringify(link));
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
  console.log('\n--- Sign In link (§12) + mobile full-screen chat (§21) ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
