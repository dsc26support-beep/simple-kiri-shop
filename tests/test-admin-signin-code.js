/**
 * Admin sign-in code (security audit 2026-11, approved extra): an admin always
 * gets an emailed one-time code at sign-in, whether or not they turned 2FA on;
 * a non-admin seller with 2FA off still signs in in one step. Runs on the REAL
 * backend sources via the gas-harness (no network, no Google account), driven
 * through the same actions the owner-login page calls.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Username', 'PasswordHash', 'PasswordSalt', 'Email', 'Phone', 'Messenger', 'Status', 'CreatedAt', 'StoreType']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt', 'GoogleSub']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt']],
  CustomerCodes: [['Token', 'Email', 'Code', 'Purpose', 'Name', 'Phone', 'CreatedAt', 'ExpiresAt', 'Attempts', 'LinkHash', 'PasswordHash']],
  TwoFACodes: [['Token', 'OwnerId', 'Code', 'Purpose', 'CreatedAt', 'ExpiresAt', 'Attempts']]
}, { guest: true });
box.__props.PEPPER = 'test-pepper';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.ADMIN_EMAILS = 'admin@x.test';
const mail = box.__mail;
const clearCache = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const lastMailTo = (to) => mail.filter((m) => m[0] === to).slice(-1)[0];
const codeIn = (m) => (m && /code is: (\d{6})/.exec(m[2]) || [])[1];
const owners = () => box.__sheets.Owners.objects();

function makeCustomer(name, email, password) {
  const r = box.actionRegisterCustomer({ name: name, email: email, password: password });
  const v = box.actionVerifyCustomerEmail({ token: r.pendingToken, code: codeIn(lastMailTo(email)) });
  if (!v.ok) throw new Error('makeCustomer failed: ' + email + ' ' + J(v));
  return v.token;
}
let phoneSeq = 73000000;
function openStore(customerToken, storeName) {
  const r = box.actionRegisterOwner({ storeName: storeName, password: 'storepass1', phone: String(++phoneSeq),
    messenger: storeName.toLowerCase().replace(/\W+/g, '.'), about: 'Goods', customerToken: customerToken });
  if (!r.ok) throw new Error('openStore failed: ' + storeName + ' ' + J(r));
}

const adminTok = makeCustomer('Admin', 'admin@x.test', 'adminpass9');
const sellerTok = makeCustomer('Sella', 'seller@x.test', 'sellerpass9');
openStore(adminTok, 'Admin Store');
openStore(sellerTok, 'Sella Store');
ok('setup: the admin account is admin, the seller is not',
  box.isOwnerAdmin(owners().find((o) => o.Email === 'admin@x.test')) &&
  !box.isOwnerAdmin(owners().find((o) => o.Email === 'seller@x.test')));
ok('setup: neither store turned 2FA on', owners().every((o) => String(o.TwoFAEnabled) !== 'true'));

/* ---------- a non-admin seller signs in in one step ---------- */
clearCache();
let r = box.actionOwnerFromCustomer({ customerToken: sellerTok });
ok('non-admin, 2FA off: signs in directly with a session token, no code',
  r.ok && !!r.token && !r.twoFactorRequired, J(r));

/* ---------- an admin is always sent a code ---------- */
clearCache();
mail.length = 0;
r = box.actionOwnerFromCustomer({ customerToken: adminTok });
ok('admin, 2FA off: gets twoFactorRequired + a pendingToken, and NO session token',
  r.ok && r.twoFactorRequired === true && !!r.pendingToken && !r.token, J(r));
const adminMail = lastMailTo('admin@x.test');
ok('admin, 2FA off: a 6-digit login code was emailed to the admin address',
  !!codeIn(adminMail) && /login code/i.test(adminMail ? adminMail[1] : ''), adminMail && adminMail[1]);
ok('the code row is stored under the admin owner, with a login purpose and an expiry',
  (() => { const row = box.__sheets.TwoFACodes.objects().slice(-1)[0];
    return row && row.Purpose === 'login' && !!row.OwnerId && !!row.ExpiresAt; })());

/* ---------- a wrong code is refused; the right one signs in ---------- */
const pending = r.pendingToken;
let bad = box.actionVerifyLoginCode({ pendingToken: pending, code: '000000' === codeIn(adminMail) ? '111111' : '000000' });
ok('a wrong code is refused', !bad.ok, J(bad));
r = box.actionVerifyLoginCode({ pendingToken: pending, code: codeIn(adminMail) });
ok('the right code completes sign-in with a working owner session',
  r.ok && !!r.token && (() => { try { return box.requireAuth(r.token).OwnerId === owners().find((o) => o.Email === 'admin@x.test').OwnerId; } catch (e) { return false; } })(), J(r));
let reuse = box.actionVerifyLoginCode({ pendingToken: pending, code: codeIn(adminMail) });
ok('the code cannot be reused', !reuse.ok, J(reuse));

/* ---------- it is forced by admin status, independent of the 2FA flag ---------- */
// Turn the seller into an admin by listing their email; they must now be gated too.
box.__props.ADMIN_EMAILS = 'admin@x.test, seller@x.test';
clearCache();
r = box.actionOwnerFromCustomer({ customerToken: sellerTok });
ok('a seller added to ADMIN_EMAILS is now also sent a code (gate follows admin status)',
  r.ok && r.twoFactorRequired === true && !r.token, J(r));

R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
