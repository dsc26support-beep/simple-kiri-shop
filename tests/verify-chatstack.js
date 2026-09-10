// The full-screen mobile chat must sit ABOVE the bottom nav. Reproduces the
// reported symptom directly: the message box was unreachable because the nav
// was painted over it.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = [{ productId: 'p1', name: 'Rice', category: 'pantry', description: 'x', imageUrl: '',
  variants: [{ variantId: 'v1', label: '1kg', price: 6 }], rating: null, reviewCount: 0 }];

async function openChat(browser, width, height, path) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') return J({ ok: true, storeName: 'Teaube', storePhone: '73001224', storeOpen: true, products: PRODUCTS });
    if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
    if (a === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Teaube', storeSlug: 'teaube', phone: '73001224', messenger: '', logoUrl: '', island: 'South Tarawa', village: '', isOpen: true, deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true, deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null } });
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'teaube');
    // Past the "What's your name?" gate, so the composer is live - which is the
    // state the reported screenshot was in.
    localStorage.setItem('skiri_chat_name_teaube', 'Test Shopper');
    localStorage.setItem('skiri_chat_token_teaube', 'tok-teaube');
  });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const f = document.getElementById('chat-fab'); if (f) f.click();
    await new Promise((r) => setTimeout(r, 400));
  });
  return { ctx, page };
}

const stack = (page) => page.evaluate(() => {
  const win = document.querySelector('.chat-window');
  const nav = document.querySelector('.bottom-nav');
  const input = document.querySelector('#chat-window .chat-window-input-row') ||
                document.querySelector('.chat-window-input-row');
  const box = input ? input.getBoundingClientRect() : null;
  // What does the browser actually paint at the middle of the message box?
  const hit = box ? document.elementFromPoint(Math.round(box.left + box.width / 2),
                                              Math.round(box.top + box.height / 2)) : null;
  const inChat = hit ? !!hit.closest('.chat-window') : null;
  const inNav = hit ? !!hit.closest('.bottom-nav') : null;
  return {
    chatZ: win ? Number(getComputedStyle(win).zIndex) : null,
    navZ: nav ? Number(getComputedStyle(nav).zIndex) : null,
    navDisplay: nav ? getComputedStyle(nav).display : null,
    open: win ? win.classList.contains('chat-window--open') : null,
    hitTag: hit ? hit.tagName.toLowerCase() : null,
    inChat, inNav
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- phone: the reported case --- */
  let { ctx, page } = await openChat(browser, 390, 844, '/product.html?store=teaube&product=p1');
  let s = await stack(page);
  ok('phone: chat window is open', s.open === true);
  ok('phone: bottom nav is shown', s.navDisplay === 'grid', String(s.navDisplay));
  ok('phone: chat outranks the nav', s.chatZ > s.navZ, `chat=${s.chatZ} nav=${s.navZ}`);
  ok('phone: the message box is what gets tapped, not the nav',
    s.inChat === true && s.inNav === false, `hit=<${s.hitTag}> inChat=${s.inChat} inNav=${s.inNav}`);
  // And it must actually accept typing.
  // A real tap and real keystrokes - if the nav were still on top, Playwright's
  // click would land on the nav (or be refused as intercepted) rather than
  // reaching the textarea. This is the assertion that actually reproduces the
  // reported symptom.
  const sel = '.chat-window textarea, #chat-message-input';
  let typed;
  try {
    await page.click(sel, { timeout: 3000 });
    await page.type(sel, 'Mauri noo');
    typed = await page.evaluate((q) => {
      const t = document.querySelector(q);
      return { focused: document.activeElement === t, value: t.value };
    }, sel);
  } catch (err) {
    typed = { error: String(err).split('\n')[0] };
  }
  ok('phone: the message box can be tapped and typed into',
    !!typed && typed.focused === true && typed.value === 'Mauri noo', JSON.stringify(typed));
  await ctx.close();

  /* --- same on a store page and the cart page --- */
  for (const p of ['/store.html?store=teaube', '/cart.html']) {
    const { ctx: c, page: pg } = await openChat(browser, 390, 844, p);
    const st = await stack(pg);
    ok(`phone ${p.split('?')[0]}: message box not covered`, st.inChat === true && st.inNav === false,
      `hit=<${st.hitTag}> chat=${st.chatZ} nav=${st.navZ}`);
    await c.close();
  }

  /* --- tablet width still uses the floating window; nav is hidden there --- */
  ({ ctx, page } = await openChat(browser, 900, 800, '/product.html?store=teaube&product=p1'));
  s = await stack(page);
  ok('desktop: chat stays the floating panel (1002)', s.chatZ === 1002, String(s.chatZ));
  ok('desktop: bottom nav is hidden', s.navDisplay === 'none', String(s.navDisplay));
  await ctx.close();

  /* --- modals must still beat the full-screen chat --- */
  ({ ctx, page } = await openChat(browser, 390, 844, '/product.html?store=teaube&product=p1'));
  const modal = await page.evaluate(() => {
    const win = document.querySelector('.chat-window');
    const probe = document.createElement('div');
    probe.className = 'loading-overlay';
    document.body.appendChild(probe);
    const chooser = document.createElement('div');
    chooser.className = 'login-chooser-overlay';
    document.body.appendChild(chooser);
    return { chat: Number(getComputedStyle(win).zIndex),
             loading: Number(getComputedStyle(probe).zIndex),
             chooser: Number(getComputedStyle(chooser).zIndex) };
  });
  ok('loading overlay still beats the full-screen chat', modal.loading > modal.chat, JSON.stringify(modal));
  ok('login chooser still beats everything', modal.chooser > modal.loading, JSON.stringify(modal));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Chat above the bottom nav ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
