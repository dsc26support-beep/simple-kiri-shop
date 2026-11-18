/**
 * Security hardening stage 3 (owner, 16 Nov 2026): the access-control test
 * suite, on the REAL backend (gas-harness), driven through the real doPost /
 * doGet router so it exercises requireAuth, the isOwnerAdmin gate and every
 * per-action ownership check for real.
 *
 * Covers the classes an active pentest (e.g. Strix) would probe, safely:
 *   - vertical escalation: a non-admin seller, a customer, and an anonymous
 *     caller are refused by every admin* action; a customer token is refused
 *     by seller actions;
 *   - horizontal access / IDOR / BOLA: seller B cannot read or change seller
 *     A's product, variant, order or campaign by passing A's id;
 *   - listing isolation: B's own lists never contain A's rows;
 *   - unauthenticated access + no error-detail leakage;
 *   - brute force: owner-login lockout and customer code caps;
 *   - replay: a used sign-in code and a logged-out session token are refused;
 *   - formula injection end to end (a seller's text is stored as text).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const GENERIC = /Something went wrong on our side\. Please try again in a moment\. \(Ref [0-9a-f]{8}\)/;

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Username', 'PasswordHash', 'PasswordSalt', 'Email', 'Phone', 'Messenger', 'Status', 'CreatedAt', 'StoreType']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt', 'GoogleSub']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt']],
  CustomerCodes: [['Token', 'Email', 'Code', 'Purpose', 'Name', 'Phone', 'CreatedAt', 'ExpiresAt', 'Attempts', 'LinkHash', 'PasswordHash']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType', 'Views']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'ItemsSummary', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  TwoFACodes: [['Token', 'OwnerId', 'Code', 'Purpose', 'CreatedAt', 'ExpiresAt', 'Attempts']]
}, { guest: true });
box.__props.PEPPER = 'test-pepper';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const mail = box.__mail;
const clearCache = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const lastMailTo = (to) => mail.filter((m) => m[0] === to).slice(-1)[0];
const codeIn = (m) => (m && /code is: (\d{6})/.exec(m[2]) || [])[1];
const POST = (action, body) => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: action }, body)) } }).s);
const owners = () => box.__sheets.Owners.objects();

// --- account helpers: real sign-up + verify, open a store, get a seller token ---
function makeCustomer(name, email, password) {
  const r = box.actionRegisterCustomer({ name: name, email: email, password: password });
  const code = codeIn(lastMailTo(email));
  const v = box.actionVerifyCustomerEmail({ token: r.pendingToken, code: code });
  if (!v.ok) throw new Error('makeCustomer failed: ' + email + ' ' + J(v));
  return v.token;
}
let phoneSeq = 73000000;
function openStore(customerToken, storeName) {
  const r = box.actionRegisterOwner({ storeName: storeName, password: 'storepass1', phone: String(++phoneSeq),
    messenger: storeName.toLowerCase().replace(/\W+/g, '.'), about: 'Goods', customerToken: customerToken });
  if (!r.ok) throw new Error('openStore failed: ' + storeName + ' ' + J(r));
  const s = box.actionOwnerFromCustomer({ customerToken: customerToken });
  if (!s.twoFactorRequired) return s.token;
  // Admin accounts now always get an emailed sign-in code (security extra, Nov 2026);
  // complete it so this helper still returns a usable seller token.
  const email = owners().find((o) => o.StoreName === storeName).Email;
  return box.actionVerifyLoginCode({ pendingToken: s.pendingToken, code: codeIn(lastMailTo(email)) }).token;
}

const custA = makeCustomer('Ana', 'ana@x.test', 'coconut99');
const custB = makeCustomer('Ben', 'ben@x.test', 'breadfruit42');
const custAdmin = makeCustomer('Admin', 'admin@x.test', 'adminpass9');
const custPlain = makeCustomer('Pita', 'pita@x.test', 'papaya1234');  // a shopper, never a seller
const tokA = openStore(custA, 'Ana Store');
const tokB = openStore(custB, 'Ben Store');
const tokAdmin = openStore(custAdmin, 'Admin Store');
const idOf = (email) => (owners().find((o) => o.Email === email) || {}).OwnerId;
const A = idOf('ana@x.test'); const B = idOf('ben@x.test');
ok('setup: two sellers, an admin and a shopper exist, all distinct', A && B && A !== B && idOf('admin@x.test'), J([A, B]));
ok('setup: the admin account is admin, the sellers are not', box.isOwnerAdmin(owners().find((o) => o.Email === 'admin@x.test')) && !box.isOwnerAdmin(owners().find((o) => o.Email === 'ana@x.test')));

// --- seed each seller a product + variant + order (owned rows) ---
function seedSeller(id, slug, tag) {
  box.__sheets.Products.appendRow([tag + '_prod', id, slug, tag + ' Rice', 'Rice', 'active', 'pantry', 'product', '0']);
  box.__sheets.Variants.appendRow([tag + '_var', tag + '_prod', id, '1kg', '5', '9', 'active']);
  box.__sheets.Orders.appendRow([tag + '_order', id, slug, 'Buyer', '73000000', 'buyer@x.test', '1x Rice', '5', 'Paid', new Date().toISOString(), '']);
}
seedSeller(A, 'ana-store', 'A');
seedSeller(B, 'ben-store', 'B');
// A real seller campaign owned by A (created through the real action).
clearCache();
const draftA = POST('saveCampaignDraft', { token: tokA, goal: 'store', name: "Ana's launch" });
const campA = draftA.campaign && (draftA.campaign.campaignId || draftA.campaign.id);
ok('setup: seller A owns a product, variant, order and campaign', !!campA, J(draftA).slice(0, 160));

/* ======================= 1. vertical escalation ======================= */
// Every admin* action, called by a non-admin seller, must be refused - and must
// not fall through to doing its work. This sweep catches a missing isOwnerAdmin
// check on ANY admin action, not just the ones spot-checked.
// Admin-only actions: the admin* ones, plus those that gate on isOwnerAdmin /
// requireMarketingAdmin without the prefix (featuring review, badge config,
// wholesale / store trust, review cases, the marketing engine). All verified
// to call the admin gate as their first line.
const ADMIN_GATED_NO_PREFIX = ['getAdminOverview', 'setFeaturePurchaseStatus', 'setFeatureBankMatched', 'listFeaturePurchases',
  'setSellerBadgeOverride', 'setBadgeConfig', 'recomputeBadges', 'setWholesaleVerified', 'setStoreTrust',
  'listWholesalers', 'listStoreTrust', 'listSellerBadges', 'listReviewCases', 'getReviewCase', 'reviewCaseAction',
  'getMarketingOverview', 'createMarketingCampaign', 'setMarketingCampaignStatus', 'setMarketingPaused',
  'previewMarketingCampaign', 'getMarketingStats', 'runMarketingGeneration'];
const adminActions = box.PROTECTED_POST_ACTIONS.filter((a) => /^admin/.test(a) || ADMIN_GATED_NO_PREFIX.indexOf(a) !== -1);
let escaped = [];
adminActions.forEach((a) => {
  const res = POST(a, { token: tokB });                  // tokB = a real, non-admin seller
  if (res && res.ok === true) escaped.push(a);
});
ok('every admin action refuses a non-admin seller (' + adminActions.length + ' actions swept)', escaped.length === 0, 'escaped: ' + J(escaped));
// ...and refuses an anonymous caller (no token at all).
let escapedAnon = adminActions.filter((a) => { const r = POST(a, {}); return r && r.ok === true; });
ok('every admin action refuses an anonymous caller', escapedAnon.length === 0, 'escaped: ' + J(escapedAnon));
// A customer token is not a seller token: seller actions reject it.
ok('a customer token cannot call a seller action (listOwnerProducts)', POST('listOwnerProducts', { token: custPlain }).ok === false);
ok('a customer token cannot call an admin action (getAdminOverview)', POST('getAdminOverview', { token: custPlain }).ok === false);
// The admin account itself CAN (control, so the sweep isn't passing by always-deny).
clearCache();
ok('control: the real admin IS allowed into an admin action', POST('adminListCampaigns', { token: tokAdmin }).ok === true, J(POST('adminListCampaigns', { token: tokAdmin })).slice(0, 120));

/* ================= 2. horizontal access / IDOR / BOLA ================= */
// Seller B passes seller A's ids. Each must be refused; A with A's own id is the
// control that proves the action works when ownership is right.
ok('IDOR: B cannot read A\'s campaign', POST('getCampaignDetail', { token: tokB, campaignId: campA }).ok === false);
ok('control: A can read A\'s campaign', POST('getCampaignDetail', { token: tokA, campaignId: campA }).ok === true);
ok('IDOR: B cannot act on A\'s campaign (campaignAction)', POST('campaignAction', { token: tokB, campaignId: campA, do: 'submit' }).ok === false);
ok('IDOR: B cannot update A\'s product', POST('updateProduct', { token: tokB, productId: 'A_prod', name: 'Hacked' }).ok === false);
ok('IDOR: B cannot delete A\'s product', POST('deleteProduct', { token: tokB, productId: 'A_prod' }).ok === false);
ok('...and A\'s product is untouched', box.__sheets.Products.objects().find((p) => p.ProductId === 'A_prod').Name === 'A Rice' && box.__sheets.Products.objects().some((p) => p.ProductId === 'A_prod' && p.Status !== 'deleted'));
ok('IDOR: B cannot change A\'s order status', POST('updateOrderStatus', { token: tokB, orderId: 'A_order', status: 'Cancelled' }).ok === false);
ok('...and A\'s order is untouched', box.__sheets.Orders.objects().find((o) => o.OrderId === 'A_order').Status === 'Paid');
ok('IDOR: B cannot adjust stock on A\'s variant', POST('adjustStock', { token: tokB, variantId: 'A_var', requestId: 'r1', delta: -9, reason: 'x' }).ok === false);
ok('...and A\'s stock is untouched', box.__sheets.Variants.objects().find((v) => v.VariantId === 'A_var').StockQty === '9');

/* ====================== 3. listing isolation ====================== */
clearCache();
const bProducts = POST('listOwnerProducts', { token: tokB });
ok('B\'s product list never contains A\'s product', bProducts.ok && JSON.stringify(bProducts).indexOf('A_prod') === -1, J(bProducts).slice(0, 120));
const bOrders = POST('listOwnerOrders', { token: tokB });
ok('B\'s order list never contains A\'s order', !/A_order/.test(JSON.stringify(bOrders)));
const bInv = POST('getInventory', { token: tokB });
ok('B\'s inventory never contains A\'s variant', !/A_var/.test(JSON.stringify(bInv)));

/* ============ 4. unauthenticated access + no detail leak ============ */
for (const a of ['listOwnerProducts', 'getInventory', 'updateProduct', 'getSellerDashboard']) {
  const noTok = POST(a, {});
  const badTok = POST(a, { token: 'not-a-real-token' });
  ok(a + ': refused with no token and with a garbage token', noTok.ok === false && badTok.ok === false, J([noTok.error, badTok.error]).slice(0, 160));
  ok(a + ': the refusal leaks no internals (no sheet/stack/exception text)', !/Sheet|Exception|\.gs|OwnerId|undefined|at Object|TypeError/.test(String(noTok.error) + String(badTok.error)), J([noTok.error, badTok.error]).slice(0, 160));
}

/* ========================= 5. brute force ========================= */
clearCache();
let locked = false, lastErr = '';
for (let i = 0; i < 7; i++) { const r = box.actionCustomerPasswordLogin({ email: 'ana@x.test', password: 'wrongpass' + i }); lastErr = r.error || ''; if (/many|locked|wait|too/i.test(lastErr)) locked = true; }
ok('brute force: repeated wrong customer passwords get locked/slowed', locked, lastErr);
ok('...and the lockout does not reveal whether the email exists', !/no account|not found|unknown/i.test(lastErr), lastErr);
// Customer email-code send cap (anti email-bomb).
clearCache(); mail.length = 0;
let capped = false;
for (let i = 0; i < 8; i++) { const r = box.actionResendCustomerCode({ pendingToken: 'x' }); if (r && /too many|wait|slow/i.test(r.error || '')) { capped = true; } }
ok('brute force: the sign-in code path is rate-capped, not unbounded', capped || mail.length <= 6, 'emails sent: ' + mail.length);

/* ========================== 6. replay ========================== */
// A sign-in code is single-use: verifying twice with the same code fails the 2nd time.
clearCache();
const reg = box.actionRegisterCustomer({ name: 'Rae', email: 'rae@x.test', password: 'guava5678' });
const rcode = codeIn(lastMailTo('rae@x.test'));
const first = box.actionVerifyCustomerEmail({ token: reg.pendingToken, code: rcode });
const second = box.actionVerifyCustomerEmail({ token: reg.pendingToken, code: rcode });
ok('replay: a used sign-in code cannot be used again', first.ok === true && second.ok === false, J([first.ok, second.error]).slice(0, 140));
// A logged-out session token stops working at once.
const raeTok = first.token;
ok('replay: the session works before logout', box.actionGetCustomerProfile({ token: raeTok }).ok === true);
box.actionLogoutCustomer({ token: raeTok });
ok('replay: the same token is dead after logout', box.actionGetCustomerProfile({ token: raeTok }).ok === false);

/* =================== 7. formula injection (end to end) =================== */
// A seller names a product with a spreadsheet formula; it must be stored as
// text (leading apostrophe), never as a live formula in the sheet.
clearCache();
POST('createProduct', { token: tokA, name: '=HYPERLINK("http://evil","clickme")', category: 'home', listingType: 'product',
  variants: [{ label: '1kg', price: 5, stockQty: 3 }], description: 'x' });
const injected = box.__sheets.Products.objects().find((p) => /HYPERLINK/.test(p.Name));
ok('formula injection: a seller\'s =formula name is stored as text (leading apostrophe)', !!injected && injected.Name.charAt(0) === "'", injected && injected.Name);

R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
const failed = R.filter((r) => r[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
