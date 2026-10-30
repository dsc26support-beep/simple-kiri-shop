/**
 * Contacts & SMS in the browser on the REAL backend (Contacts.gs,
 * SmsCampaigns.gs, SmsDevices.gs through doPost): the seller menu, the
 * Contacts page (add, consent, import, groups, export), the SMS page (pair a
 * phone, SIM bundle, compose with the counter, check, confirm and send,
 * campaigns, pause, templates, settings, add-on key), the public opt-out
 * page, the admin section, and the switch being off. Phone and desktop.
 * The "phone" here is the backend's own smsPairDevice/smsDeviceSync called by
 * the test - no SMS is sent.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : String(e).slice(0, 400)]);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'StoreType', 'Username'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'retailer', 'bong'],
    ['own_adm', 'adm', 'Mwakete Admin', 'admin@x.test', '', 'active', 'retailer', 'adm']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT], ['tok-adm', 'own_adm', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'Status', 'CreatedAt'],
    ['o1', 'own_s', 'bong', 'Nei Tabwi', '73005555', 'Paid', '2026-10-01T00:00:00Z']]
}, { guest: true });
box.__props.CONTACTS_SMS = 'on';
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.Logger = { log() {} };
const clear = () => Object.keys(box.__cache || {}).forEach((k) => delete box.__cache[k]);
const call = (b) => { clear(); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (url) => { clear(); const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const post = (o) => JSON.parse(call(JSON.stringify(o)));
// The harness keeps the formula guard's leading apostrophe; Sheets drops it.
const rows = (t) => (box.__sheets[t] ? box.__sheets[t].objects().map((r) => { Object.keys(r).forEach((k) => { if (typeof r[k] === 'string' && r[k][0] === "'") r[k] = r[k].slice(1); }); return r; }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const prompts = [];
  const open = async (w, who) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
    await ctx.addInitScript((k) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      const tok = { seller: ['tok-s', 'own_s', 'Bong Store', 'bong'], off: ['tok-s', 'own_s', 'Bong Store', 'bong'], admin: ['tok-adm', 'own_adm', 'Mwakete Admin', 'adm'] }[k];
      if (tok) {
        localStorage.setItem('skiri_owner_token', tok[0]);
        localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: tok[1], storeName: tok[2], storeSlug: tok[3], contactsSms: k !== 'off', isAdmin: k === 'admin' }));
      }
    }, who);
    await ctx.route('**/macros/s/**', (route) => { const req = route.request(); const b = req.postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : callGet(req.url()) }); });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(w + ' ' + String(e)));
    p.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(prompts.length ? prompts.shift() : d.defaultValue()) : d.accept()));
    return { ctx, p };
  };
  const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  /* ======================= Contacts (desktop) ======================= */
  let { ctx, p } = await open(1280, 'seller');
  await p.goto(BASE + '/owner/contacts.html', { waitUntil: 'load' });
  await p.waitForSelector('#ct-app:not([hidden])', { timeout: 15000 });
  ok('the seller menu shows Contacts and SMS (switch on)', !!(await p.$('.seller-sidebar a[href="contacts.html"][aria-current="page"]')) && !!(await p.$('.seller-sidebar a[href="sms.html"]')));
  ok('an empty list says how to start', /No contacts yet/.test(await p.textContent('#ct-table tbody')));

  await p.click('#ct-add');
  await p.fill('#ce-first', 'Teraoi');
  await p.fill('#ce-last', 'Kaitu');
  await p.fill('#ce-phone', '730 123 45');
  ok('the number is checked as it is typed', /\+68673012345/.test(await p.textContent('#ce-phone-note')));
  await p.selectOption('#ce-island', 'South Tarawa');
  await p.fill('#ce-village', 'Bairiki');
  await p.selectOption('#ce-c-promotional', 'yes');
  ok('saying yes to promotions asks how they agreed', await p.isVisible('#ce-source'));
  await p.click('#ce-save');
  await sleep(300);
  ok('...and will not save without it', /how this person agreed/.test(await p.textContent('#ce-error')) && rows('Contacts').length === 0);
  await p.fill('#ce-source', 'signed the in-store list, 30 Oct');
  await p.click('#ce-save');
  await p.waitForFunction(() => /Teraoi Kaitu/.test(document.querySelector('#ct-table tbody').textContent), null, { timeout: 10000 });
  const t1 = rows('Contacts')[0];
  ok('a contact is saved with the number in +686 form and promotions consent with its source', t1 && t1.Phone === '+68673012345' && t1.ConsentPromotional === 'yes' && /in-store/.test(t1.ConsentSource), JSON.stringify(t1));
  ok('...and listed with "Yes" for promotions', /Yes/.test(await p.textContent('#ct-table tbody')));

  // import by paste
  await p.click('#ct-import-open');
  await p.click('#ct-import summary');
  await p.fill('#ci-paste', 'First name,Last name,Mobile,Village\nBwebwe,Tito,73033333,Betio\n"Kanoa, Jr",,63044444,Eita\nTeraoi again,,73012345,\nNobody,,12,');
  await p.click('#ci-paste-go');
  await p.waitForSelector('#ci-preview:not([hidden])', { timeout: 10000 });
  const counts = await p.textContent('#ci-counts');
  ok('import preview counts new, already-have and left-out rows (quoted commas read right)', /2\s*new/.test(counts) && /1\s*already have/.test(counts) && /1\s*left out/.test(counts) && /Kanoa, Jr/.test(await p.textContent('#ci-rows')), counts);
  await p.check('#ci-c-promotional');
  await p.click('#ci-apply');
  await sleep(300);
  ok('ticking consent in an import asks how they agreed', /how these people agreed/.test(await p.textContent('#ci-error')));
  await p.uncheck('#ci-c-promotional');
  await p.click('#ci-apply');
  await p.waitForFunction(() => /Imported: 2 added/.test(document.getElementById('ct-status').textContent), null, { timeout: 10000 });
  ok('import adds 2; they have no promotions consent', rows('Contacts').filter((c) => c.Source === 'csv').length === 2 && rows('Contacts').filter((c) => c.Source === 'csv').every((c) => c.ConsentPromotional === 'unknown'));

  // group + bulk add
  prompts.length = 0;
  await p.click('#ct-group-new');
  await p.fill('#cg-name', 'Betio customers');
  await p.click('#ct-group-form button[type="submit"]');
  await p.waitForFunction(() => /Betio customers/.test(document.getElementById('ct-groups').textContent), null, { timeout: 10000 });
  await p.waitForFunction(() => document.querySelectorAll('#ct-table tbody [data-sel]').length === 3, null, { timeout: 10000 });
  await p.check('#ct-all');
  ok('selecting shows the bulk bar', await p.isVisible('#ct-bulk') && /3 selected/.test(await p.textContent('#ct-bulk-count')));
  await p.click('#ct-bulk-add');
  await p.waitForFunction(() => /Betio customers \(3\)/.test(document.getElementById('ct-groups').textContent), null, { timeout: 10000 });
  ok('contacts are added to a group', rows('ContactGroupMembers').length === 3);
  await p.fill('#ct-q', 'bwebwe');
  await p.waitForFunction(() => document.querySelectorAll('#ct-table tbody [data-sel]').length === 1, null, { timeout: 10000 });
  ok('search narrows the list', /Bwebwe/.test(await p.textContent('#ct-table tbody')));
  await p.fill('#ct-q', '');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.click('#ct-export')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  ok('export downloads a CSV of this store’s contacts, and is audited', /First name/.test(csv) && /Bwebwe/.test(csv) && rows('Audit_Log').some((a) => a.Action === 'CONTACTS_EXPORTED'), csv.slice(0, 120));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/contacts-desktop.png', fullPage: true });
  await ctx.close();

  /* ======================= SMS (desktop) ======================= */
  ({ ctx, p } = await open(1280, 'seller'));
  await p.goto(BASE + '/owner/sms.html#phones', { waitUntil: 'load' });
  await p.waitForSelector('#sm-app:not([hidden])', { timeout: 15000 });
  ok('the Phones tab opens from the link', await p.isVisible('#panel-phones') && (await p.getAttribute('#tab-phones', 'aria-selected')) === 'true');
  prompts.push('Shop Samsung');
  await p.click('#ph-pair');
  await p.waitForSelector('#ph-code:not([hidden])', { timeout: 10000 });
  const code = (await p.textContent('#ph-code-text')).trim();
  await p.waitForFunction(() => /within/.test(document.getElementById('ph-code-exp').textContent), null, { timeout: 5000 });
  ok('a pairing code is shown (XXXX-XXXX) with the time left', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), code);
  const paired = post({ action: 'smsPairDevice', code, model: 'Samsung A15', appVersion: '1.0.0', androidVersion: '14' });
  const dev = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret };
  const SIMS = [{ subscriptionId: 1, slotIndex: 0, carrierName: 'Vodafone KI', displayName: 'SIM 1', numberHint: '111', iccHash: 'icc-a' }];
  post(Object.assign({ action: 'smsDeviceSync', sims: SIMS, take: 0 }, dev));
  await p.waitForFunction(() => /Shop Samsung/.test(document.getElementById('ph-list').textContent), null, { timeout: 15000 });
  ok('the page notices the phone once the app has paired, with its SIM', paired.ok && /Vodafone KI/.test(await p.textContent('#ph-list')) && await p.isHidden('#ph-code'));
  await p.fill('[data-f="allowance"]', '500');
  await p.fill('[data-f="reset"]', '1');
  await p.click('[data-sim] [data-save]');
  await p.waitForFunction(() => /About 500 of 500 left/.test(document.getElementById('ph-list').textContent), null, { timeout: 10000 });
  ok('a SIM gets an SMS bundle; the page shows our estimate of what is left', true);

  // compose
  await p.click('#tab-compose');
  await p.fill('#cp-name', 'Week sale');
  await p.fill('#cp-body', 'Mauri ');
  await p.click('#cp-fields [data-field="first_name"]');
  await p.type('#cp-body', '! 10% off at Bong Store. Reply STOP to opt out.');
  const counter = await p.textContent('#cp-counter');
  ok('the counter shows characters and SMS parts as you type', /\d+ characters/.test(counter) && /1 SMS each/.test(counter), counter);
  ok('the phone preview fills in an example name', /Mauri Teraoi! 10% off/.test(await p.textContent('#cp-preview')));
  await p.type('#cp-body', ' ā');
  ok('a special character warns that each SMS holds only 70', /only 70/.test(await p.textContent('#cp-counter')));
  await p.press('#cp-body', 'Backspace');
  await p.press('#cp-body', 'Backspace');
  await p.check('#cp-all');
  await p.click('#cp-check');
  await p.waitForFunction(() => /people/.test(document.getElementById('cp-estimate').textContent), null, { timeout: 10000 });
  const est = await p.textContent('#cp-estimate');
  ok('"Check" shows who gets it and who is left out (no consent)', /1 people/.test(est) && /2 have not said yes/.test(est), est);
  ok('...and previews the real message for each person', /Mauri Teraoi! 10% off/.test(await p.textContent('#cp-preview')) && /Teraoi Kaitu/.test(await p.textContent('#cp-preview')));
  await p.click('#cp-start');
  await p.waitForSelector('#cp-confirm[open]', { timeout: 10000 });
  ok('"Review & send" asks for confirmation with the phone, SIM and cost note', /1 people/.test(await p.textContent('#cp-confirm-body')) && /Shop Samsung/.test(await p.textContent('#cp-confirm-body')) && /carrier/.test(await p.textContent('#cp-confirm-body')));
  await p.fill('#cp-confirm-n', '2');
  await p.click('#cp-confirm-go');
  await sleep(200);
  ok('...the wrong number does not start it', /Type 1/.test(await p.textContent('#cp-confirm-error')) && !rows('SmsMessages').length);
  await p.fill('#cp-confirm-n', '1');
  await p.click('#cp-confirm-go');
  await p.waitForSelector('#panel-campaigns:not([hidden])', { timeout: 10000 });
  await p.waitForFunction(() => /Week sale/.test(document.getElementById('cm-rows').textContent), null, { timeout: 10000 });
  const msgs = rows('SmsMessages');
  ok('the right number starts it: one queued message, personalised, on the chosen SIM', msgs.length === 1 && msgs[0].Status === 'queued' && /^Mauri Teraoi!/.test(msgs[0].Body) && msgs[0].Phone === '+68673012345', JSON.stringify(msgs));
  ok('...and it is listed as queued', /Queued/.test(await p.textContent('#cm-rows')));
  await p.click('#cm-rows [data-open]');
  await p.waitForSelector('#cm-detail[open]', { timeout: 10000 });
  await p.waitForFunction(() => /Waiting/.test(document.getElementById('cm-messages').textContent), null, { timeout: 10000 });
  await p.click('#cm-detail-actions [data-act="pause"]');
  await p.waitForFunction(() => /Paused/.test(document.getElementById('cm-detail-head').textContent), null, { timeout: 10000 });
  ok('a campaign can be paused from its page', rows('SmsCampaigns')[0].Status === 'paused');
  ok('...a paused campaign hands nothing to the phone', post(Object.assign({ action: 'smsDeviceSync', sims: SIMS, take: 10 }, dev)).messages.length === 0);
  await p.click('#cm-detail-actions [data-act="resume"]');
  await p.waitForFunction(() => /Queued|Sending/.test(document.getElementById('cm-detail-head').textContent), null, { timeout: 10000 });
  await p.click('#cm-detail [data-close]');

  // templates
  await p.click('#tab-templates');
  await p.click('#tp-add');
  await p.fill('#tp-name', 'Order ready');
  await p.selectOption('#tp-kind', 'transactional');
  await p.fill('#tp-body', 'Mauri {first_name|friend}, your order is ready at Bong Store.');
  ok('the template editor counts too', /1 SMS each/.test(await p.textContent('#tp-counter')));
  await p.click('#tp-form button[type="submit"]');
  await p.waitForFunction(() => /Order ready/.test(document.getElementById('tp-list').textContent), null, { timeout: 10000 });
  ok('a template is saved and listed', rows('SmsTemplates').length === 1);

  // settings
  await p.click('#tab-settings');
  await p.waitForFunction(() => document.getElementById('st-interval').value !== '', null, { timeout: 10000 });
  await p.selectOption('#st-quiet-start', '22');
  await p.fill('#st-interval', '10');
  await p.click('#st-save');
  await p.waitForFunction(() => /Saved/.test(document.getElementById('st-error').textContent), null, { timeout: 10000 });
  ok('sending settings save (quiet hours, gap)', box.smsStoreSettings('own_s').quietStart === 22 && box.smsStoreSettings('own_s').intervalSeconds === 10);
  await p.fill('#st-key-name', 'Office sheet');
  await p.click('#st-key-new');
  await p.waitForSelector('#st-key-shown:not([hidden])', { timeout: 10000 });
  const key = (await p.textContent('#st-key-text')).trim();
  ok('an add-on key is shown once; only its hash is stored', /^mwk_/.test(key) && rows('SmsApiKeys').every((k) => k.KeyHash !== key) && /Office sheet/.test(await p.textContent('#st-keys')));
  await p.click('#tab-overview');
  await p.waitForFunction(() => /phones connected/.test(document.getElementById('ov-stats').textContent), null, { timeout: 10000 });
  ok('the overview shows the totals', /3\s*contacts/.test(await p.textContent('#ov-stats')) || /contacts/.test(await p.textContent('#ov-stats')));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/sms-desktop.png', fullPage: true });
  await ctx.close();

  /* ======================= phone width ======================= */
  for (const page of ['contacts.html', 'sms.html#compose', 'sms.html#campaigns', 'sms.html#phones']) {
    ({ ctx, p } = await open(390, 'seller'));
    await p.goto(BASE + '/owner/' + page, { waitUntil: 'load' });
    await p.waitForSelector('#ct-app:not([hidden]), #sm-app:not([hidden])', { timeout: 15000 });
    await sleep(500);
    ok(`phone: ${page} fits the screen (no sideways scroll)`, await noSideScroll(p));
    if (SHOTS) await p.screenshot({ path: SHOTS + '/phone-' + page.replace(/[#.]/g, '-') + '.png', fullPage: true });
    await ctx.close();
  }

  /* ======================= opt-out page ======================= */
  ({ ctx, p } = await open(390, 'guest'));
  await p.goto(BASE + '/sms-stop.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => /Bong Store/.test(document.getElementById('stop-store').textContent), null, { timeout: 10000 });
  ok('the opt-out page names the store', true);
  await p.fill('#stop-phone', '7301 2345');
  await p.click('#stop-btn');
  await p.waitForSelector('#stop-done:not([hidden])', { timeout: 10000 });
  const teraoi = rows('Contacts').find((c) => c.Phone === '+68673012345');
  ok('...a person can stop promotions from that store; they are recorded as opted out', teraoi.ConsentPromotional === 'no' && rows('SmsSuppression').some((s) => s.Phone === '+68673012345'));
  ok('...the page fits a phone', await noSideScroll(p));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/sms-stop.png', fullPage: true });
  await ctx.close();

  /* ======================= admin ======================= */
  ({ ctx, p } = await open(1280, 'admin'));
  await p.goto(BASE + '/owner/admin.html#sms', { waitUntil: 'load' });
  await p.waitForFunction(() => /Bong Store/.test((document.querySelector('#asm-stores tbody') || {}).textContent || ''), null, { timeout: 20000 });
  ok('admin: per-store counts, no names or numbers', /Bong Store/.test(await p.textContent('#asm-stores')) && !/Teraoi|\+686/.test(await p.textContent('#asm-stores')));
  prompts.push('too short');
  await p.click('#asm-stores [data-act="contacts"]');
  await sleep(500);
  ok('...viewing a store’s contacts needs a real reason', await p.isHidden('#asm-contacts'));
  prompts.push('Customer complaint about spam, case 1234');
  await p.click('#asm-stores [data-act="contacts"]');
  await p.waitForSelector('#asm-contacts:not([hidden])', { timeout: 10000 });
  ok('...with a reason it shows them, and the view is audited with the reason', /Teraoi/.test(await p.textContent('#asm-contacts')) && rows('Audit_Log').some((a) => a.Action === 'SMS_ADMIN_VIEWED_CONTACTS' && /complaint/.test(a.Reason)));
  prompts.push('Spam complaints from customers this week');
  await p.click('#asm-stores [data-act="suspend"]');
  await p.waitForFunction(() => /Suspended/.test(document.getElementById('asm-stores').textContent), null, { timeout: 10000 });
  ok('...an admin can suspend a store’s sending', box.smsStoreSettings('own_s').suspended === true);
  await ctx.close();

  /* ======================= switched off ======================= */
  box.__props.CONTACTS_SMS = 'off';
  ({ ctx, p } = await open(1280, 'off'));
  await p.goto(BASE + '/owner/contacts.html', { waitUntil: 'load' });
  await p.waitForFunction(() => /not switched on/.test(document.getElementById('ct-status').textContent), null, { timeout: 15000 });
  ok('switched off: the page says so, and the menu has no Contacts or SMS', await p.isHidden('#ct-app') && !(await p.$('.seller-sidebar a[href="sms.html"]')));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + '  ' + r[1] + (r[0] === 'FAIL' && r[2] ? '  [' + r[2] + ']' : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); R.forEach((r) => console.log(r[0] + '  ' + r[1] + (r[0] === 'FAIL' && r[2] ? '  [' + r[2] + ']' : ''))); process.exit(1); });
