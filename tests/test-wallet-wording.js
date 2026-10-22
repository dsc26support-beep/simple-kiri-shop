/**
 * Driver wallet wording (phase 5): the site must not make a blanket "Mwakete
 * never holds money" promise any more, now that it holds a delivery fee paid
 * through Mwakete for a driver. And it must never over-promise the other way
 * (escrow, insurance, guarantee).
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

/* Phrases that were true before the wallet and are not any more when said without a limit. */
const BLANKET = [/never\s+handles?\s+your\s+money/i, /never\s+holds?\s+your\s+money/i, /never\s+holds?\s+money(?!\s+for)/i, /never\s+takes?\s+payment(?!\s+for)/i,
  /does\s+not\s+hold\s+or\s+pay\s+money/i, /does\s+not\s+handle\s+the\s+money/i, /does\s+not\s+hold\s+payments/i];
const USER_FACING = ['terms.html', 'privacy.html', 'order-room.html', 'driver.html', 'customer-dashboard.html', 'checkout.html', 'help.html', 'assets/js/help-content.js', 'assets/js/order-room.js',
  'assets/js/driver.js', 'assets/js/customer-dashboard.js', 'assets/js/checkout.js'];
for (const f of USER_FACING) {
  const text = strip(read(f));
  const hit = BLANKET.find((re) => re.test(text));
  ok(`${f}: no blanket "never holds money" promise`, !hit, hit ? String(hit) + ' -> ' + (text.match(hit) || [''])[0] : '');
}

const terms = strip(read('terms.html'));
ok('terms: a "Mwakete drivers and delivery fees" section exists and is linkable', /id="drivers"/.test(read('terms.html')) && /Mwakete drivers and delivery fees/.test(terms));
ok('terms: says Mwakete holds the delivery fee only, never the price of goods', /holds the delivery fee only \(never the price of goods\)/.test(terms));
ok('terms: says what happens before and after the driver collects the goods', /before the driver collects the goods, Mwakete returns the fee to the seller/.test(terms) && /after the driver has collected the goods/.test(terms));
ok('terms: says it is not escrow, insurance or a guarantee', /not escrow, insurance or a guarantee/.test(terms));
ok('terms: the headline promise is limited to goods', /never handles the money you pay for what you buy/.test(terms));
ok('terms: independent drivers, not employees or agents', /independent people.*not employees or agents/.test(terms));
ok('terms: the "Last updated" date moved on', /Last updated: 22 October 2026/.test(terms));
ok('the Terms link from the order room, driver page and the driver list points at the section',
  ['order-room.html', 'driver.html'].every((f) => /terms\.html#drivers/.test(read(f))));
ok('privacy: explains driver data, location and payout details', /If you drive for Mwakete/.test(read('privacy.html')) && /only your latest\s+position/.test(read('privacy.html').replace(/\s+/g, ' ').replace('latest position', 'latest  position')) || /latest position/.test(strip(read('privacy.html'))));
ok('privacy: buyers are told what a driver can see', /A Mwakete driver<\/strong> sees your name/.test(read('privacy.html')));

const wording = USER_FACING.map(read).join('\n');
ok('nothing says "escrow", "insured" or "guaranteed" about a delivery', !/(escrow(?! ,)|insured|guaranteed)(?![^<]{0,40}not)/i.test(strip(read('driver.html') + read('order-room.html') + read('assets/js/order-room.js') + read('assets/js/driver.js'))));
ok('the driver page no longer says drivers are paid directly by the seller as a rule', !/fee the seller will pay you directly/.test(read('driver.html')));

let fails = 0;
console.log('\n--- driver wallet wording ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
