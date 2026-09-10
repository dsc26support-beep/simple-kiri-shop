// Unit tests for the seller-contact helpers, run against the REAL helpers.js.
//
// The dangerous piece here is whatsappUrl: a Kiribati number is stored as eight
// local digits, and wa.me/73007552 is not a real number anywhere - the link
// would open WhatsApp on an error page rather than the seller. So the country
// code is the thing worth pinning down.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const grab = (re) => {
  const m = helpers.match(re);
  if (!m) throw new Error('source not found: ' + re);
  return m[0];
};

const ctx = { String: String, window: {} };
vm.createContext(ctx);
vm.runInContext([
  grab(/function classifyKiribatiPhone[\s\S]*?\n}/),
  // escapeHtml is the one helper here that needs a DOM (textContent ->
  // innerHTML). Stubbed with the same semantics - &, < and > escaped, quotes
  // NOT - so escapeAttr is tested doing the real work rather than being handed
  // an already-safe string.
  "function escapeHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
  grab(/function escapeAttr[\s\S]*?\n}/),
  grab(/function messengerUrl[\s\S]*?\n}/),
  grab(/const NO_CONTACT_MESSAGES = \{[\s\S]*?\n\};/),
  grab(/function whatsappUrl[\s\S]*?\n}/),
  grab(/function sellerContactButtons[\s\S]*?\n}/),
  "const PHONE_ICON_SVG = '<phone/>';",
  "const WHATSAPP_ICON_SVG = '<wa/>';",
  "const MESSENGER_ICON_SVG = '<msgr/>';",
  'this.NO_CONTACT_MESSAGES = NO_CONTACT_MESSAGES;'
].join('\n'), ctx);

// --- whatsappUrl ---
ok('local 8-digit number gets the 686 country code',
  ctx.whatsappUrl('73007552') === 'https://wa.me/68673007552', ctx.whatsappUrl('73007552'));
ok('+686 number is not double-prefixed',
  ctx.whatsappUrl('+686 730 07552') === 'https://wa.me/68673007552', ctx.whatsappUrl('+686 730 07552'));
ok('00686 form is handled',
  ctx.whatsappUrl('00686-73007552') === 'https://wa.me/68673007552', ctx.whatsappUrl('00686-73007552'));
ok('overseas number keeps its own country code',
  ctx.whatsappUrl('+6421234567') === 'https://wa.me/6421234567', ctx.whatsappUrl('+6421234567'));
ok('spaces, dashes and brackets are stripped',
  ctx.whatsappUrl('(730) 075-52') === 'https://wa.me/68673007552', ctx.whatsappUrl('(730) 075-52'));
ok('blank gives no url', ctx.whatsappUrl('') === '' && ctx.whatsappUrl(null) === '' && ctx.whatsappUrl(undefined) === '');
ok('punctuation-only gives no url rather than wa.me/686', ctx.whatsappUrl('--') === '', ctx.whatsappUrl('--'));

// --- sellerContactButtons ---
const full = ctx.sellerContactButtons({ phone: '73007552', whatsapp: '63012345', messenger: 'bongshop' });
ok('all three buttons render when everything is set',
  (full.match(/btn-call/g) || []).length === 1 &&
  (full.match(/btn-whatsapp/g) || []).length === 1 &&
  (full.match(/btn-messenger/g) || []).length === 1, full);
ok('call is a tel: link', /href="tel:73007552"/.test(full), full);
ok('separate whatsapp number is used when given', /wa\.me\/68663012345/.test(full), full);
ok('messenger goes to m.me', /href="https:\/\/m\.me\/bongshop"/.test(full), full);
ok('nothing is marked unavailable when everything is set', !/data-no-contact/.test(full), full);
ok('external links open in a new tab with rel=noopener',
  (full.match(/target="_blank" rel="noopener"/g) || []).length === 2, full);
ok('the call link does NOT get target=_blank (tel: must stay in-page)',
  !/btn-call" href="tel:[^"]*" target/.test(full), full);

const fallback = ctx.sellerContactButtons({ phone: '73007552', whatsapp: '', messenger: '' });
ok('WhatsApp falls back to the contact phone when no separate number is set',
  /wa\.me\/68673007552/.test(fallback), fallback);
ok('a seller with no Messenger gets an unavailable Messenger button, not a missing one',
  /data-no-contact="messenger"/.test(fallback) && /btn-messenger/.test(fallback), fallback);

const none = ctx.sellerContactButtons({});
ok('all three are still rendered when the seller gave nothing',
  /data-no-contact="call"/.test(none) && /data-no-contact="whatsapp"/.test(none) &&
  /data-no-contact="messenger"/.test(none), none);
ok('unavailable buttons are <button>, never a dead href', !/href=/.test(none), none);
ok('unavailable buttons carry is-unavailable', (none.match(/is-unavailable/g) || []).length === 3, none);
ok('no whatsapp fallback to a blank phone', !/wa\.me/.test(none), none);
ok('sellerContactButtons tolerates being called with nothing at all',
  typeof ctx.sellerContactButtons() === 'string');

// --- the messages themselves ---
const M = ctx.NO_CONTACT_MESSAGES;
ok('WhatsApp message is the wording the site owner asked for',
  M.whatsapp === 'Akea ana WhatsApp te seller aio — this seller has no WhatsApp.', M.whatsapp);
ok('Messenger message follows the same pattern',
  /^Akea ana Messenger te seller aio — /.test(M.messenger), M.messenger);
ok('phone message follows the same pattern', /^Akea ana namba te seller aio — /.test(M.call), M.call);
ok('every message carries both languages',
  ['call', 'whatsapp', 'messenger'].every((k) => /Akea ana/.test(M[k]) && /this seller has no/.test(M[k])));

// --- escaping ---
// A seller controls their own phone/messenger fields, so these land in an href
// on a page their own customers open. escapeHtml alone does not escape a quote,
// which is what escapeAttr exists for.
const nasty = ctx.sellerContactButtons({ phone: 'x" onmouseover="alert(1)', messenger: '"><img src=x>' });
// The quote survives as text inside the attribute (&quot;) - what must not
// survive is a raw quote, which is what would end the href early.
ok('a quote in a seller field cannot close the href and add an attribute',
  !/onmouseover="/.test(nasty) && !/<img/.test(nasty) && /&quot;/.test(nasty), nasty);
ok('every href in the output is a single well-formed attribute',
  (nasty.match(/href="/g) || []).length === 3 &&
  nasty.split('href="').slice(1).every((rest) => !/^[^"]*"[^ >]/.test(rest)), nasty);
ok('escapeAttr escapes both quote styles',
  ctx.escapeAttr('a"b\'c') === 'a&quot;b&#39;c', ctx.escapeAttr('a"b\'c'));

// --- backend wiring (source-level; nothing here can call Apps Script) ---
const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const pubOwner = (auth.match(/function publicOwnerFields[\s\S]*?\n}/) || [''])[0];
const pubStore = (auth.match(/function publicStoreFields[\s\S]*?\n}/) || [''])[0];
ok('publicOwnerFields exposes whatsapp', /whatsapp: owner\.WhatsApp/.test(pubOwner));
ok('publicStoreFields exposes whatsapp (checkout reads this one)', /whatsapp: owner\.WhatsApp/.test(pubStore));
ok('listProducts sends storeWhatsapp (store + product pages read this one)',
  /storeWhatsapp: owner\.WhatsApp/.test(products));

// Sliced to the NEXT top-level function, not to the first closing brace - this
// function has nested blocks and a non-greedy match stops inside it.
const updStart = products.indexOf('function actionUpdateOwnerProfile');
const updEnd = products.indexOf('\nfunction ', updStart + 1);
const upd = products.slice(updStart, updEnd === -1 ? products.length : updEnd);
ok('the owner profile save accepts whatsapp', /body\.whatsapp !== undefined/.test(upd));
ok('whatsapp is length-capped like every other free-text field',
  /capLength\(body\.whatsapp, 30/.test(upd), upd.slice(0, 0));
ok('ensureColumn runs BEFORE the write, or the value is silently dropped',
  upd.indexOf("ensureColumn(sheet, 'WhatsApp')") !== -1 &&
  upd.indexOf("ensureColumn(sheet, 'WhatsApp')") < upd.indexOf('updateRowFromObject(sheet,'), '');
ok('nothing in this change deletes or renames a column',
  !/deleteColumn|removeColumn|setValues\(\[\[/.test(upd));

// --- owner settings page ---
const settingsHtml = fs.readFileSync(REPO + 'owner/settings.html', 'utf8');
const settingsJs = fs.readFileSync(REPO + 'assets/js/owner-settings.js', 'utf8');
ok('settings page has a WhatsApp input', /id="contact-whatsapp"/.test(settingsHtml));
ok('the WhatsApp input is marked optional', /WhatsApp Number \(Optional\)/.test(settingsHtml));
ok('settings page explains the blank-means-phone fallback',
  /different number/i.test(settingsHtml));
ok('settings form loads the saved value', /contact-whatsapp'\)\.value = owner\.whatsapp/.test(settingsJs));
ok('settings form saves it', /whatsapp: document\.getElementById\('contact-whatsapp'\)\.value\.trim\(\)/.test(settingsJs));

// --- the dead Call-only path is gone ---
const checkout = fs.readFileSync(REPO + 'assets/js/checkout.js', 'utf8');
const checkoutHtml = fs.readFileSync(REPO + 'checkout.html', 'utf8');
ok('wireCallLink is gone from checkout.js', !/wireCallLink/.test(checkout));
ok('#call-seller-link is gone from checkout.html', !/call-seller-link/.test(checkoutHtml));
ok('checkout.html has the contact block instead', /id="order-contact"/.test(checkoutHtml));
ok('renderOrderContact runs on the failed-order path too - that is the path that needs it most',
  (checkout.match(/renderOrderContact\(\);/g) || []).length === 2, '');

console.log('\n--- Seller contact helpers (unit) ---');
let failed = 0;
for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
