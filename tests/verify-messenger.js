// Facebook Messenger: required at signup, normalized to one stored shape,
// still editable later, and still optional for stores that predate the rule.
const fs = require('fs');
const vm = require('vm');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const feSrc = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const beSrc = fs.readFileSync(REPO + 'apps-script/Utils.gs', 'utf8');

const grab = (src, re) => { const m = src.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
const fe = {}; const be = {};
vm.createContext(fe); vm.createContext(be);
vm.runInContext(grab(feSrc, /const BARE_MESSENGER_HOSTS = \[[\s\S]*?\];/) + '\n' +
  grab(feSrc, /function messengerHandle[\s\S]*?\n}/) + '\n' +
  grab(feSrc, /function messengerStoredValue[\s\S]*?\n}/), fe);
vm.runInContext(grab(beSrc, /var BARE_MESSENGER_HOSTS = \[[\s\S]*?\];/) + '\n' +
  grab(beSrc, /function messengerHandle[\s\S]*?\n}/) + '\n' +
  grab(beSrc, /function messengerStoredValue[\s\S]*?\n}/), be);

/* ---------- what a vendor actually types or pastes ---------- */
const CASES = [
  // [input, expected stored value]
  ['mystore',                             'https://m.me/mystore'],
  ['  mystore  ',                         'https://m.me/mystore'],
  ['@mystore',                            'https://m.me/mystore'],
  ['@@mystore',                           'https://m.me/mystore'],
  ['first.last',                          'https://m.me/first.last'],
  ['m.me/mystore',                        'https://m.me/mystore'],
  ['M.ME/MyStore',                        'https://m.me/MyStore'],
  ['https://m.me/mystore',                'https://m.me/mystore'],
  ['http://m.me/mystore',                 'https://m.me/mystore'],
  ['https://www.facebook.com/mystore',    'https://m.me/mystore'],
  ['https://facebook.com/mystore/',       'https://m.me/mystore'],
  ['https://m.facebook.com/mystore?x=1',  'https://m.me/mystore'],
  ['https://web.facebook.com/mystore',    'https://m.me/mystore'],
  ['facebook.com/mystore',                'https://m.me/mystore'],
  ['fb.me/mystore',                       'https://m.me/mystore'],
  ['fb.com/mystore',                      'https://m.me/mystore'],
  ['https://messenger.com/t/mystore',     'https://m.me/mystore'],
  // A profile with no username set - m.me accepts the numeric id.
  ['facebook.com/profile.php?id=123456',  'https://m.me/123456'],
  ['https://www.facebook.com/profile.php?ref=x&id=987', 'https://m.me/987'],
  // Nothing usable.
  ['',                                    ''],
  ['   ',                                 ''],
  ['@',                                   ''],
  ['https://example.com/evil',            ''],
  ['facebook.com',                        ''],
  ['my store',                            ''],   // a space is not a username
  ['<script>alert(1)</script>',           ''],
  ['../../etc/passwd',                    ''],
  ['..',                                  ''],
  ['.',                                   ''],
  ['.hidden',                             ''],
  ['www.facebook.com',                    ''],
  ['m.me',                                ''],
  ['M.ME',                                ''],
  ['fb.me',                               ''],
  ['https://facebook.com',                ''],
  ['-leading-dash',                       ''],
  // Legitimate, and must survive the tightening.
  ['bong.store',                          'https://m.me/bong.store'],
  ['My-Page_2',                           'https://m.me/My-Page_2'],
  ['123456',                              'https://m.me/123456'],
];

for (const [input, expected] of CASES) {
  const got = fe.messengerStoredValue(input);
  ok(`frontend: ${JSON.stringify(input)}`, got === expected, `got ${JSON.stringify(got)}`);
}

// The pair is only useful if it agrees. A browser that normalizes one way and a
// backend that normalizes another means what the vendor is shown is not what
// gets stored.
const disagree = CASES.map(([i]) => i).filter((i) => fe.messengerStoredValue(i) !== be.messengerStoredValue(i));
ok('the browser and Apps Script normalizers agree on every case',
  disagree.length === 0, disagree.map((d) => JSON.stringify(d)).join(', '));

// Running it again on its own output must not change it, or a vendor who opens
// Settings and presses Save twice ends up with m.me/https or worse.
const notIdempotent = CASES.map(([, e]) => e).filter((e) => e && fe.messengerStoredValue(e) !== e);
ok('normalizing an already-stored value leaves it alone', notIdempotent.length === 0, notIdempotent.join(', '));

/* ---------- the forms ---------- */
const login = fs.readFileSync(REPO + 'owner/login.html', 'utf8');
const settings = fs.readFileSync(REPO + 'owner/settings.html', 'utf8');
const field = (html, id) => (html.match(new RegExp(`<input id="${id}"[^>]*>`)) || [''])[0];
const label = (html, id) => (html.match(new RegExp(`<label for="${id}">([^<]*)</label>`)) || [])[1] || '';

ok('signup label no longer says (Optional)', !/\(Optional\)/i.test(label(login, 'register-messenger')),
  label(login, 'register-messenger'));
ok('settings label no longer says (Optional)', !/\(Optional\)/i.test(label(settings, 'contact-messenger')),
  label(settings, 'contact-messenger'));
ok('signup placeholder is the asked-for wording',
  /placeholder="Type\/Paste Profile Name here"/.test(field(login, 'register-messenger')),
  field(login, 'register-messenger'));
ok('settings placeholder matches it',
  /placeholder="Type\/Paste Profile Name here"/.test(field(settings, 'contact-messenger')),
  field(settings, 'contact-messenger'));
ok('signup marks the field required', / required[ >]/.test(field(login, 'register-messenger')),
  field(login, 'register-messenger'));
ok('settings does NOT, so existing stores can still save',
  !/ required[ >]/.test(field(settings, 'contact-messenger')), field(settings, 'contact-messenger'));
ok('the helper text talks about a Facebook profile, not a store name',
  /Facebook profile name/.test(login) && /Facebook profile name/.test(settings));

/* ---------- the backend is the one that decides ---------- */
const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
ok('registration refuses a blank Messenger server-side',
  /var messengerLink = messengerStoredValue\(messenger\);[\s\S]{0,220}?return fail\(/.test(auth));
ok('registration writes the normalized link, not the raw input',
  /Messenger: messengerLink,/.test(auth) && !/Messenger: messenger,/.test(auth));
ok('a settings edit normalizes too',
  /update\.Messenger = messengerStoredValue\(body\.messenger\);/.test(products));
ok('a settings edit does NOT refuse blank',
  !/messengerStoredValue\(body\.messenger\)[\s\S]{0,160}?return fail\(/.test(products));
ok('the length cap grew to fit a full URL',
  /capLength\(messenger, 200,/.test(auth) && /capLength\(body\.messenger, 200,/.test(products));

// The read path must keep working for rows written before this - they hold a
// bare handle, and rewriting live vendor rows to match is not this change's job.
ok('messengerUrl still normalizes a legacy bare handle on read',
  /function messengerUrl/.test(feSrc) && /'https:\/\/m\.me\/' \+ encodeURIComponent/.test(feSrc));

/* ---------- live ---------- */
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let posted = null;
  await ctx.route('**/macros/s/**', (r) => {
    let a = '';
    try { const j = r.request().postDataJSON(); if (j) { a = j.action; if (a === 'registerOwner') posted = j; } } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'registerOwner') return J({ ok: true, token: 't', owner: { ownerId: 'o1', storeName: 'X' } });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/owner/login.html?tab=register', { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const fill = async (messenger) => {
    await page.fill('#register-store-name', 'Bong Store');
    await page.fill('#register-username', 'bong');
    await page.fill('#register-password', 'longenoughpw');
    await page.fill('#register-email', 'a@b.com');
    await page.fill('#register-phone', '73007552');
    await page.fill('#register-messenger', messenger);
  };

  // A space passes the browser's `required` check, so this reaches our own.
  await fill(' ');
  await page.click('#register-submit-btn');
  await page.waitForTimeout(400);
  ok('a whitespace-only entry is refused with a required message',
    /required/i.test(await page.locator('#register-error').innerText()) && posted === null,
    await page.locator('#register-error').innerText());

  await fill('https://example.com/notfacebook');
  await page.click('#register-submit-btn');
  await page.waitForTimeout(400);
  const junkMsg = await page.locator('#register-error').innerText();
  ok('a link that is not a profile gets its OWN message, not "required"',
    /doesn't look like/i.test(junkMsg) && posted === null, junkMsg);

  await fill('https://www.facebook.com/bong.store');
  await page.click('#register-submit-btn');
  await page.waitForTimeout(700);
  ok('a pasted Facebook link is sent as an m.me link',
    posted && posted.messenger === 'https://m.me/bong.store', posted && posted.messenger);
  ok('and the box shows the vendor what was saved',
    (await page.locator('#register-messenger').inputValue().catch(() => '')) === 'https://m.me/bong.store'
    || page.url().includes('settings.html'), page.url());
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  await browser.close();

  /* ---------- version guards ---------- */
  const { execSync } = require('child_process');
  let changed = '';
  try { changed = execSync('git -C ' + REPO + ' diff --name-only origin/main -- apps-script/', { encoding: 'utf8' }).trim(); } catch (e) {}
  if (changed) {
    const mine = (fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1];
    let theirs = '';
    try {
      theirs = (execSync('git -C ' + REPO + ' show origin/main:apps-script/Code.gs', { encoding: 'utf8' })
        .match(/APP_VERSION = '([^']+)'/) || [])[1];
    } catch (e) {}
    ok('an Apps Script change bumps APP_VERSION', mine !== theirs, `${theirs} -> ${mine}`);
  } else {
    ok('no APP_VERSION bump owed', true);
  }

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
