/**
 * Mwakete authentication (owner-approved model, Oct 2026) on the REAL backend
 * sources (gas-harness): shopper sign-up with a password, email confirmation
 * by code or link, password sign-in, "email me a code", forgot password,
 * non-enumerating replies, hashed tokens, resend cooldown, suspension, Google
 * and Facebook identities (no auto-merge by email), Facebook token checks,
 * seller applications with admin-only review, and the delivery-only phone rule.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Username', 'PasswordHash', 'PasswordSalt', 'Email', 'Phone', 'Messenger', 'Status', 'CreatedAt', 'StoreType']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt', 'GoogleSub'],
    ['cus_legacy', 'Old Google', 'old@x.test', '', 'true', '', '', '123456789012345678901']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt']],
  CustomerCodes: [['Token', 'Email', 'Code', 'Purpose', 'Name', 'Phone', 'CreatedAt', 'ExpiresAt', 'Attempts']],
  MarketingPreferences: [['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']]
}, { guest: true });
box.__props.PEPPER = 'test-pepper';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.ADMIN_EMAILS = 'boss@x.test';
const mail = box.__mail;
const clearCache = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const lastMailTo = (to) => mail.filter((m) => m[0] === to).slice(-1)[0];
const codeIn = (m) => (m && /code is: (\d{6})/.exec(m[2]) || [])[1];
const linkIn = (m, p) => (m && new RegExp(p + '=([^\\s]+)').exec(m[2]) || [])[1];
const customers = () => box.__sheets.Customers.objects();
const cust = (email) => customers().find((c) => c.Email === email);

/* ---------- sign-up ---------- */
let r = box.actionRegisterCustomer({ name: 'Tia', email: 'Tia@X.test', password: 'short' });
ok('sign-up: a short password is refused', !r.ok && /at least 8/.test(r.error), J(r));
r = box.actionRegisterCustomer({ name: 'Tia', email: 'tia@x.test', password: 'coconut99' });
ok('sign-up: sends a code, masks the email, no account yet', r.ok && r.pendingToken && r.sentTo === 't•••@x.test' && !cust('tia@x.test'), J(r));
const signupPending = r.pendingToken;
let m = lastMailTo('tia@x.test');
ok('the email has a code and a confirm link', !!codeIn(m) && !!linkIn(m, 'verify'), m && m[2]);
ok('the code row stores only hashes of the tokens and the password', (() => {
  const row = box.__sheets.CustomerCodes.objects().slice(-1)[0];
  return row.Token.startsWith('h1:') && row.LinkHash.startsWith('h1:') && row.Token !== 'h1:' + signupPending &&
    row.PasswordHash.startsWith('pbkdf2$') && !JSON.stringify(row).includes('coconut99');
})());
r = box.actionResendCustomerCode({ pendingToken: signupPending });
ok('resend straight away is refused (60s cooldown)', !r.ok && /wait a minute/.test(r.error), J(r));
r = box.actionVerifyCustomerEmail({ token: signupPending, code: '000000' === codeIn(m) ? '111111' : '000000' });
ok('a wrong code fails', !r.ok && /Incorrect code/.test(r.error), J(r));
r = box.actionVerifyCustomerEmail({ token: signupPending, code: codeIn(m) });
ok('the right code creates a confirmed account and signs in', r.ok && r.token && cust('tia@x.test') && cust('tia@x.test').EmailVerified === 'true', J(r));
const tiaToken = r.token;
ok('the session is stored hashed, not as the token', box.__sheets.CustomerSessions.objects().every((s) => s.Token !== tiaToken && s.Token.startsWith('h1:')));
r = box.actionVerifyCustomerEmail({ token: signupPending, code: codeIn(m) });
ok('the code works only once', !r.ok, J(r));

/* ---------- enumeration ---------- */
mail.length = 0; clearCache();
r = box.actionRegisterCustomer({ name: 'Tia again', email: 'tia@x.test', password: 'different99' });
const rNew = box.actionRegisterCustomer({ name: 'Nobody', email: 'fresh@x.test', password: 'different99' });
ok('sign-up with a taken email looks the same as a new one', r.ok && rNew.ok && Object.keys(r).sort().join() === Object.keys(rNew).sort().join(), J(r));
ok('...the real owner gets an "already have an account" email, no code', /already have a Mwakete account/.test((lastMailTo('tia@x.test') || [])[1]) && !codeIn(lastMailTo('tia@x.test')));
ok('...and the taken account keeps its password', box.verifyPassword('coconut99', cust('tia@x.test').PasswordHash, ''));

/* ---------- password sign-in ---------- */
clearCache();
r = box.actionCustomerPasswordLogin({ email: 'TIA@x.test', password: 'coconut99' });
ok('password sign-in works (email case-insensitive)', r.ok && !!r.token, J(r));
const wrong = box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'wrong-pass' });
const none = box.actionCustomerPasswordLogin({ email: 'nobody@x.test', password: 'wrong-pass' });
ok('wrong password and unknown email give the same reply', !wrong.ok && !none.ok && wrong.error === none.error && wrong.error === 'Email or password is incorrect', J([wrong, none]));
for (let i = 0; i < 6; i++) box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'wrong-pass' });
r = box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'coconut99' });
ok('repeated failures lock the address for a while', !r.ok && /Too many failed/.test(r.error), J(r));
clearCache();

/* ---------- email me a code ---------- */
mail.length = 0;
r = box.actionLoginCustomer({ email: 'tia@x.test' });
const rNone = box.actionLoginCustomer({ email: 'ghost@x.test' });
ok('"email me a code": same reply for an account and for none', r.ok && rNone.ok && Object.keys(r).sort().join() === Object.keys(rNone).sort().join());
ok('...the stranger address gets a note, not a code', !codeIn(lastMailTo('ghost@x.test')) && /no account for it yet/.test(lastMailTo('ghost@x.test')[2]));
r = box.actionVerifyCustomerLogin({ token: r.pendingToken, code: codeIn(lastMailTo('tia@x.test')) });
ok('the emailed code signs in', r.ok && !!r.token, J(r));
r = box.actionVerifyCustomerLogin({ token: rNone.pendingToken, code: '123456' });
ok('a decoy token never signs in', !r.ok, J(r));

/* ---------- forgot password ---------- */
clearCache(); mail.length = 0;
r = box.actionRequestCustomerPasswordReset({ email: 'tia@x.test' });
m = lastMailTo('tia@x.test');
const resetLink = decodeURIComponent(linkIn(m, 'reset'));
ok('reset email has a code and a reset link', r.ok && !!codeIn(m) && !!resetLink, m && m[2]);
ok('checkCustomerLink reads the link without using it', box.actionCheckCustomerLink({ linkToken: resetLink }).purpose === 'reset');
r = box.actionResetCustomerPassword({ linkToken: resetLink, newPassword: 'short' });
ok('reset with a weak password refused (link not used up)', !r.ok && box.actionCheckCustomerLink({ linkToken: resetLink }).ok);
r = box.actionResetCustomerPassword({ linkToken: resetLink, newPassword: 'breadfruit42' });
ok('reset by link sets the password and signs in', r.ok && !!r.token && box.verifyPassword('breadfruit42', cust('tia@x.test').PasswordHash, ''), J(r));
ok('...every older session is signed out', (() => { try { box.requireCustomerAuth(tiaToken); return false; } catch (e) { return true; } })());
ok('...the link is single use', !box.actionResetCustomerPassword({ linkToken: resetLink, newPassword: 'breadfruit43' }).ok);
const tia2 = r.token;

/* ---------- sign out everywhere / suspension ---------- */
ok('profile lists sign-in methods', box.actionGetCustomerProfile({ token: tia2 }).signInMethods.password === true);
const sheetC = box.__sheets.Customers;
const setCell = (sheet, id, col, v) => { const g = sheet.grid; const ci = g[0].indexOf(col) >= 0 ? g[0].indexOf(col) : (g[0].push(col), g[0].length - 1); g.find((row) => row[0] === id)[ci] = v; };
setCell(sheetC, cust('tia@x.test').CustomerId, 'Status', 'suspended');
ok('a suspended shopper is refused on every signed-in call', (() => { try { box.requireCustomerAuth(tia2, { allowUnverified: true }); return false; } catch (e) { return /suspended/.test(e.message); } })());
clearCache();
ok('...and cannot sign in again', !box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'breadfruit42' }).ok);
setCell(sheetC, cust('tia@x.test').CustomerId, 'Status', '');
r = box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'breadfruit42' });
const tia3 = r.token;
box.actionLogoutAllCustomerSessions({ token: tia3 });
ok('"sign out of all devices" ends this session too', (() => { try { box.requireCustomerAuth(tia3); return false; } catch (e) { return true; } })());

/* ---------- Google (no auto-merge by email) ---------- */
box.UrlFetchApp.fetch = (url) => {
  const claims = { aud: 'gid', iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 600), email_verified: 'true',
    email: url.includes('tok-tia') ? 'tia@x.test' : (url.includes('tok-new') ? 'newg@x.test' : 'old@x.test'),
    sub: url.includes('tok-tia') ? '900000000000000000001' : (url.includes('tok-new') ? '900000000000000000002' : '123456789012345678901'), name: 'G' };
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify(claims) };
};
box.__props.GOOGLE_CLIENT_ID = 'gid';
clearCache();
r = box.actionGoogleSignIn({ credential: 'tok-legacy' });
ok('Google: a pre-existing GoogleSub link still signs straight in', r.ok && r.customer && r.customer.email === 'old@x.test', J(r));
ok('...and is copied into ProviderIdentities as id:<sub>', box.__sheets.ProviderIdentities.objects().some((i) => i.ProviderUserId === 'id:123456789012345678901'));
r = box.actionGoogleSignIn({ credential: 'tok-tia' });
ok('Google with the email of an existing account does NOT sign in - link required', r.ok && r.linkRequired && !r.token && r.providerLinkToken, J(r));
const gLink = r.providerLinkToken;
ok('...the pending link is cached under a hash, not the raw token', Object.keys(box.__cache).some((k) => k.startsWith('providerlink:h1:')) && !Object.keys(box.__cache).some((k) => k.includes(gLink)));
r = box.finishCustomerSignIn(cust('old@x.test'), { providerLinkToken: gLink }, 'test');
ok('...a different account cannot take the pending link', !r.ok && /only be linked to the account it matched/.test(r.error), J(r));
r = box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'breadfruit42', providerLinkToken: gLink });
ok('proving the account with its password makes the link', r.ok && r.linked === 'google', J(r));
r = box.actionGoogleSignIn({ credential: 'tok-tia' });
ok('...after which Google signs in to that account', r.ok && r.token && r.customer.email === 'tia@x.test', J(r));
r = box.actionGoogleSignIn({ credential: 'tok-new' });
ok('Google with a new email creates a confirmed account', r.ok && r.token && cust('newg@x.test').EmailVerified === 'true', J(r));

/* ---------- Facebook ---------- */
clearCache();
r = box.actionFacebookSignIn({ accessToken: 'fb-1' });
ok('Facebook without App ID/secret fails closed', !r.ok && /not set up/.test(r.error), J(r));
box.__props.FACEBOOK_APP_ID = '111'; box.__props.FACEBOOK_APP_SECRET = 'shh';
const fb = { debug: {}, me: {} };
const seen = [];
box.UrlFetchApp.fetch = (url) => {
  seen.push(url);
  const body = url.includes('/debug_token') ? { data: fb.debug } : fb.me;
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
};
const exp = Math.floor(Date.now() / 1000) + 3600;
const good = () => { fb.debug = { is_valid: true, app_id: '111', type: 'USER', user_id: '10001', expires_at: exp }; fb.me = { id: '10001', name: 'Fb User', email: 'fb@x.test' }; };
const tryFb = (patch) => { clearCache(); good(); patch(); return box.actionFacebookSignIn({ accessToken: 'fb-token' }); };
ok('Facebook: a token for another app is refused', !tryFb(() => { fb.debug.app_id = '999'; }).ok);
ok('Facebook: an invalid token is refused', !tryFb(() => { fb.debug.is_valid = false; }).ok);
ok('Facebook: an expired token is refused', !tryFb(() => { fb.debug.expires_at = Math.floor(Date.now() / 1000) - 5; }).ok);
ok('Facebook: a page/app token is refused', !tryFb(() => { fb.debug.type = 'PAGE'; }).ok);
ok('Facebook: /me id differing from debug_token is refused', !tryFb(() => { fb.me.id = '10002'; }).ok);
seen.length = 0;
r = tryFb(() => {});
ok('Facebook: a good token signs up a new account', r.ok && !!r.token, J(r));
ok('...its email is NOT trusted: pending, a code is sent', (() => { const c = customers().find((x) => x.PendingEmail === 'fb@x.test'); return c && c.EmailVerified === 'false' && !c.Email && r.verifyPendingToken; })(), J(r));
ok('...the /me call carries appsecret_proof, the secret itself never appears in it', seen.some((u) => u.includes('/me?') && /appsecret_proof=[0-9a-f]{64}/.test(u) && !u.includes('shh')));
const fbToken = r.token;
ok('...it can browse its profile but not order yet', box.actionGetCustomerProfile({ token: fbToken }).ok &&
  (() => { try { box.requireCustomerAuth(fbToken); return false; } catch (e) { return /confirm/i.test(e.message); } })());
r = box.actionVerifyCustomerEmail({ token: r.verifyPendingToken, code: codeIn(lastMailTo('fb@x.test')) });
ok('...confirming the code makes the email real', r.ok && cust('fb@x.test') && cust('fb@x.test').EmailVerified === 'true', J(r));
r = tryFb(() => { fb.me.email = 'tia@x.test'; fb.debug.user_id = '10009'; fb.me.id = '10009'; });
ok('Facebook with an existing account email asks to link instead of merging', r.ok && r.linkRequired && !r.token, J(r));
r = box.actionUnlinkProvider({ token: fbToken, provider: 'facebook' });
ok('unlinking the only way in is refused... unless email codes still work', r.ok, J(r));

/* ---------- Become a Seller: pre-approved (owner decision, 23 Oct 2026) ---------- */
clearCache();
const tia4 = box.actionCustomerPasswordLogin({ email: 'tia@x.test', password: 'breadfruit42' }).token;
const apply = (o) => box.actionRegisterOwner(Object.assign({ storeName: 'Tia Store', username: 'tiastore', password: 'storepass1', phone: '73005555',
  messenger: 'tia.store', passwordHint: 'the usual', about: 'Fish', customerToken: tia4 }, o));
r = apply({ customerToken: '' });
ok('opening a store needs a signed-in shopper account', !r.ok && r.customerAccountRequired === true, J(r));
mail.length = 0;
r = apply({ email: 'boss@x.test' });
ok('a new store opens at once and the seller is signed in', r.ok && !!r.token && r.application.status === 'approved', J(r));
const sellerSession = r.token;
ok('...the store email is the shopper account email, never a typed one', box.__sheets.Owners.objects()[0].Email === 'tia@x.test');
ok('...so an ADMIN_EMAILS address cannot be claimed by typing it', !box.isOwnerAdmin(box.__sheets.Owners.objects()[0]));
ok('...the seller gets "your store is open" and the admins "new store opened"',
  /store is open/.test((lastMailTo('tia@x.test') || [])[1]) && /New store opened/.test((lastMailTo('boss@x.test') || [])[1]));
ok('...a second store for the same account is refused', /already have a store/.test(apply({}).error || ''));
ok('...it is visible to shoppers', box.isStoreBrowsable(box.__sheets.Owners.objects()[0]));
ok('the shopper sees their store on My Account', box.actionGetSellerApplication({ token: tia4 }).application.status === 'approved');
clearCache();
ok('the seller logs in with the store password', box.actionLoginOwner({ username: 'tiastore', password: 'storepass1' }).ok);
ok('a store that applied while approval was needed ("pending") now counts as open', box.ownerApprovalStatus({ ApprovalStatus: 'pending' }) === 'approved');

const tiaOwner = Object.assign({}, box.__sheets.Owners.objects()[0], { __row: 2 });
r = box.actionAdminReviewSellerApplication(tiaOwner, { ownerId: tiaOwner.OwnerId, decision: 'suspend', note: 'x' });
ok('a non-admin cannot suspend', !r.ok && /Not authorized/.test(r.error), J(r));

const bossReg = box.actionRegisterCustomer({ name: 'Boss', email: 'boss@x.test', password: 'bosspass1' });
const bossTok = box.actionVerifyCustomerEmail({ token: bossReg.pendingToken, code: codeIn(lastMailTo('boss@x.test')) }).token;
r = box.actionRegisterOwner({ storeName: 'Admin', username: 'boss', password: 'bosspass1', phone: '73009999', messenger: 'boss', passwordHint: 'boss hint', about: '', customerToken: bossTok });
ok('the admin opens their store the same way', r.ok && !!r.token, J(r));
const admin = Object.assign({}, box.__sheets.Owners.objects()[1], { __row: 3 });
r = box.actionAdminListSellerApplications(admin, {});
ok('admin lists new stores (no password fields)', r.ok && r.applications.length === 2 && !JSON.stringify(r).includes('PasswordHash') && !JSON.stringify(r).includes('pbkdf2'), J(r));
r = box.actionAdminReviewSellerApplication(admin, { ownerId: tiaOwner.OwnerId, decision: 'suspend' });
ok('suspending needs a reason', !r.ok && /reason/.test(r.error));
r = box.actionAdminReviewSellerApplication(admin, { ownerId: tiaOwner.OwnerId, decision: 'suspend', note: 'Reports of fake goods' });
ok('admin suspends with a reason; the seller is emailed it', r.ok && /fake goods/.test(lastMailTo('tia@x.test')[2]), J(r));
ok('...the seller is signed out at once', (() => { try { box.requireAuth(sellerSession); return false; } catch (e) { return true; } })());
ok('...and the store is hidden', !box.isStoreBrowsable(box.__sheets.Owners.objects()[0]));
clearCache();
r = box.actionLoginOwner({ username: 'tiastore', password: 'storepass1' });
ok('...and cannot log in, told why', !r.ok && /suspended/.test(r.error), J(r));
r = box.actionAdminReviewSellerApplication(admin, { ownerId: admin.OwnerId, decision: 'suspend', note: 'oops' });
ok('an admin store can never be suspended here', !r.ok, J(r));
r = box.actionAdminReviewSellerApplication(admin, { ownerId: tiaOwner.OwnerId, decision: 'reinstate' });
ok('admin reinstates', r.ok && r.application.status === 'approved', J(r));
ok('every decision is in AuthEvents, with no secrets', (() => {
  const ev = box.__sheets.AuthEvents.objects();
  return ['seller-opened', 'seller-suspended', 'seller-reinstated'].every((e) => ev.some((x) => x.Event === e)) &&
    !JSON.stringify(ev).match(/breadfruit|coconut|storepass|pbkdf2|h1:/);
})());

/* ---------- "Emails from Mwakete" starts on for new accounts (owner request, Oct 2026) ---------- */
const optedIn = (id) => box.isOptedIn(box.findMarketingPreference(id));
ok('a new email sign-up starts with Emails from Mwakete on', optedIn(cust('tia@x.test').CustomerId));
ok('...so does a new Google account', optedIn(cust('newg@x.test').CustomerId));
ok('...and a new Facebook account', optedIn(cust('fb@x.test').CustomerId));
ok('an account from before keeps what it had (no row = off)', !optedIn('cus_legacy') && !box.findMarketingPreference('cus_legacy'));
box.setMarketingOptIn(cust('tia@x.test'), false);
box.optInNewCustomer(cust('tia@x.test'));
ok('turning it off sticks - the default never switches it back on', !optedIn(cust('tia@x.test').CustomerId));
ok('each new account got its own unsubscribe link token', ['tia@x.test', 'newg@x.test', 'fb@x.test'].every((e) =>
  !!box.findMarketingPreference(cust(e).CustomerId).UnsubscribeToken));

R.forEach((x) => console.log(x[0], x[1], String(x[2]).slice(0, 300).replace(/\n/g, ' ')));
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log(`${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
