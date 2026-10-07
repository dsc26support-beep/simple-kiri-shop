// Google Sheets on the Import & Sync page, end to end against the REAL
// backend (harness) with a fake seller spreadsheet: share instructions,
// pasting the link, tab + header row, column matching, "Both ways" mode,
// first-sync conflicts, deciding them, Sync now, and the Sync Center card.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = 'http://127.0.0.1:8099';
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'bong', 'Bong', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'], ['prod_r', 'own_a', 'bong', 'Rice', 'active', 'other', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'],
    ['v1', 'prod_r', 'own_a', '1kg', 2, 'R-1', 10, 'active', ''], ['v2', 'prod_r', 'own_a', '5kg', 9, 'R-5', 5, 'active', '']]
}, { external: { [SHEET_ID]: { title: 'Shop stock', tabs: {
  Notes: [['x']],
  Stock: [['Stock list', '', ''], ['Code', 'Item', 'On hand'], ['R-1', 'Rice 1kg', 12], ['R-5', 'Rice 5kg', 5]]
} } } });
box.__props.MWAKETE_SHARE_EMAIL = 'stock@mwakete.com';
const OWNER = { OwnerId: 'own_a', StoreSlug: 'bong', StoreType: '' };
const ext = () => box.__external[SHEET_ID].getSheetByName('Stock');
const v = (id) => box.__sheets.Variants.objects().find((x) => x.VariantId === id);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    let res;
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'own_a', storeName: 'Bong', storeSlug: 'bong', storeType: 'retailer' } };
    else {
      const fn = 'action' + a.charAt(0).toUpperCase() + a.slice(1);
      if (typeof box[fn] === 'function') {
        const b = JSON.parse(JSON.stringify(body)); delete b.action; delete b.token;
        res = JSON.parse(JSON.stringify(box[fn](OWNER, b)));
      } else res = { ok: true };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/owner/inventory-sync.html', { waitUntil: 'load' });
  await page.waitForSelector('.sync-source[data-source="googleSheets"]:not(.is-off)', { timeout: 6000 });
  ok('no Sync Center until something is linked', await page.isHidden('#sync-center'));

  await page.click('.sync-source[data-source="googleSheets"]');
  ok('share instructions name the Mwakete address', (await page.textContent('#sync-share-email')) === 'stock@mwakete.com' && await page.isVisible('#sync-step-sheet'));
  ok('the mapping step waits until the sheet is checked', await page.isHidden('#sync-step-map'));
  await page.fill('#sync-sheet-url', 'https://docs.google.com/spreadsheets/d/1NOTSHAREDNOTSHAREDNOTSHARED/edit');
  await page.click('#sync-sheet-check');
  await page.waitForFunction(() => /Share and add/.test(document.getElementById('sync-sheet-error').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('a sheet that isn\'t shared: tells the seller exactly what to do', /Share and add stock@mwakete\.com/.test(await page.textContent('#sync-sheet-error')));

  await page.fill('#sync-sheet-url', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`);
  await page.click('#sync-sheet-check');
  await page.waitForSelector('#sync-sheet-pick:not(.hidden)', { timeout: 4000 });
  ok('first check opens the first tab', await page.inputValue('#sync-sheet-tab') === 'Notes');
  await page.selectOption('#sync-sheet-tab', 'Stock');
  await page.fill('#sync-header-row', '2');
  await page.dispatchEvent('#sync-header-row', 'change');
  await page.waitForFunction(() => /Stock: 2 rows, 3 columns/.test(document.getElementById('sync-sheet-info').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('the right tab and header row: 2 rows, 3 columns', /Connected to "Shop stock" › Stock: 2 rows, 3 columns/.test(await page.textContent('#sync-sheet-info')), await page.textContent('#sync-sheet-info'));
  const guessed = await page.$$eval('#sync-mapping select', (s) => s.map((x) => x.dataset.header + '=' + x.value));
  ok('columns matched: Code=SKU, On hand=stock', guessed.join('|') === 'Code=sku|Item=productName|On hand=physicalStock', guessed.join('|'));
  ok('mode choice is shown for a sheet (not for CSV)', await page.isVisible('#sync-mode-field'));
  await page.check('input[name="sync-mode"][value="twoWay"]');

  await page.click('#sync-preview-btn');
  await page.waitForSelector('#sync-step-preview:not(.hidden)', { timeout: 5000 });
  ok('first two-way preview: the 1kg difference needs a decision', /First sync: your sheet says 12, Mwakete says 10/.test(await page.textContent('#sync-preview')));
  ok('nothing changed by the preview', Number(v('v1').StockQty) === 10 && ext().grid[2][2] === 12);
  await page.click('#sync-apply-btn');
  await page.waitForSelector('#sync-step-done:not(.hidden)', { timeout: 5000 });
  ok('done text says a decision is needed and hourly sync is on', /choose which number is right/.test(await page.textContent('#sync-done-text')) && /every hour/.test(await page.textContent('#sync-done-text')));
  await page.waitForSelector('.sync-conflict', { timeout: 4000 });
  ok('Sync Center shows the sheet card (needs a decision) and the conflict', await page.isVisible('#sync-center') &&
    /Needs a decision.*Shop stock.*Both ways/s.test(await page.textContent('.sync-conn')) && /Your sheet: 12/.test(await page.textContent('.sync-conflict')));

  await page.click('.sync-conflict [data-choice="external"]');
  await page.waitForFunction(() => !document.querySelector('.sync-conflict'), null, { timeout: 5000 }).catch(() => {});
  ok('choosing "Your sheet: 12" updates Mwakete and clears the conflict', Number(v('v1').StockQty) === 12 && !(await page.$('.sync-conflict')));
  ok('...and says both sides now match', /both sides now match/.test(await page.textContent('#sync-status')));

  // A change on Mwakete only is written back by Sync now.
  box.actionReceiveStock(OWNER, { variantId: 'v2', quantity: 3 });
  await page.click('.sync-conn [data-act="sync"]');
  await page.waitForFunction(() => /wrote 1 to your sheet/.test((document.querySelector('.sync-conn-result') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  ok('Sync now writes the Mwakete change into the sheet', ext().grid[3][2] === 8 && /wrote 1 to your sheet/.test(await page.textContent('.sync-conn-result')), 'cell=' + ext().grid[3][2] + ' text=' + await page.textContent('.sync-conn'));
  ok('card now Connected with last + next sync', /Connected/.test(await page.textContent('.sync-conn')) && /next about/.test(await page.textContent('.sync-conn')));
  ok('history names the sheet and mode', /Shop stock \(Both ways\)/.test(await page.textContent('#sync-history')));
  ok('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: true }).catch(() => {});

  await browser.close();
  let f = 0; console.log('\n--- Google Sheets on the Import & Sync page (real backend in harness) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
