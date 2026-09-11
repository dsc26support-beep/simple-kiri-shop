// The auth-code channel router, run against the REAL .gs sources.
//
// The assertion that matters most is the FALLBACK. A vendor whose stored
// preference is 'sms' while no SMS sender exists must still receive a code -
// a silent no-send locks them out of their own store, and it would look like
// a login bug rather than a delivery one.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const notify = fs.readFileSync(REPO + 'apps-script/Notify.gs', 'utf8');
const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');

// --- a sandbox with the Apps Script globals Notify.gs touches ---
function makeCtx(scriptProps) {
  const sent = { emails: [], sms: [] };
  const ctx = {
    String, Number, Boolean, JSON, Date, Math,
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (scriptProps || {})[k] || null })
    },
    // Stands in for Utils.gs's real sendAppEmail, which has its own suite.
    sendAppEmail: (to, subject, body) => { sent.emails.push({ to, subject, body }); return true; },
    __sent: sent
  };
  vm.createContext(ctx);
  vm.runInContext(notify, ctx);
  return ctx;
}

// ---------------- smsSenderConfigured ----------------
{
  const ctx = makeCtx({});
  ok('a default deployment has no SMS sender', ctx.smsSenderConfigured() === false);
  ok('and so nothing about it changes', ctx.sendSms('73007552', 'hi') === false);
}
{
  const ctx = makeCtx({ SMS_SENDER: '   ' });
  ok('whitespace is not configuration', ctx.smsSenderConfigured() === false);
}
{
  const ctx = makeCtx({ SMS_SENDER: 'twilio' });
  ok('a set property turns the flag on', ctx.smsSenderConfigured() === true);
  ok('but the stub still reports "did not send", so the caller falls back',
    ctx.sendSms('73007552', 'hi') === false);
}
// A Properties failure must not take out the login path.
{
  const ctx = {
    String, Number, JSON, Date,
    PropertiesService: { getScriptProperties: () => { throw new Error('boom'); } },
    sendAppEmail: () => true
  };
  vm.createContext(ctx);
  vm.runInContext(notify, ctx);
  ok('a PropertiesService failure is swallowed, not thrown',
    ctx.smsSenderConfigured() === false);
}

// ---------------- sendSms never throws ----------------
{
  const ctx = makeCtx({ SMS_SENDER: 'x' });
  const junk = [null, undefined, '', 0, {}, [], NaN];
  let threw = null;
  for (const a of junk) for (const b of junk) {
    try { ctx.sendSms(a, b); } catch (e) { threw = `${String(a)}/${String(b)}: ${e.message}`; }
  }
  ok('sendSms never throws, whatever it is handed', threw === null, String(threw));
}

// ---------------- the routing itself ----------------
const MSG = { subject: 'Subj', body: 'Long body', smsBody: 'Short body' };

{
  const ctx = makeCtx({});
  const r = ctx.sendAuthCode({ email: 'a@b.com', phone: '73007552', channel: '' }, MSG);
  ok('no preference -> email', r.sent === true && r.channel === 'email', JSON.stringify(r));
  ok('and the email body is the long one', ctx.__sent.emails[0].body === 'Long body');
}
{
  const ctx = makeCtx({});
  const r = ctx.sendAuthCode({ email: 'a@b.com', phone: '73007552', channel: 'sms' }, MSG);
  ok('THE ONE THAT MATTERS: sms preference with no sender still delivers, by email',
    r.sent === true && r.channel === 'email' && ctx.__sent.emails.length === 1, JSON.stringify(r));
}
{
  const ctx = makeCtx({ SMS_SENDER: 'configured-but-unimplemented' });
  const r = ctx.sendAuthCode({ email: 'a@b.com', phone: '73007552', channel: 'sms' }, MSG);
  ok('a configured-but-failing sender also falls back rather than dropping the code',
    r.sent === true && r.channel === 'email', JSON.stringify(r));
}
{
  const ctx = makeCtx({ SMS_SENDER: 'x' });
  const r = ctx.sendAuthCode({ email: 'a@b.com', phone: '', channel: 'sms' }, MSG);
  ok('sms preference with no phone on file -> email', r.channel === 'email', JSON.stringify(r));
}
{
  const ctx = makeCtx({});
  ctx.sendAppEmail = () => false; // simulate a bounced/quota-exceeded send
  const r = ctx.sendAuthCode({ email: 'a@b.com', channel: '' }, MSG);
  ok('a failed email reports not-sent rather than claiming success',
    r.sent === false && r.channel === 'none', JSON.stringify(r));
}
{
  const ctx = makeCtx({});
  const r = ctx.sendAuthCode({ email: '', phone: '', channel: '' }, MSG);
  ok('nothing to send to -> {sent:false, channel:none}, no throw',
    r.sent === false && r.channel === 'none', JSON.stringify(r));
}
{
  const ctx = makeCtx({});
  let threw = null;
  try { ctx.sendAuthCode(); } catch (e) { threw = e.message; }
  ok('sendAuthCode tolerates being called with nothing', threw === null, String(threw));
}
{
  const ctx = makeCtx({});
  ok('SMS preference is case-insensitive',
    ctx.effectiveAuthChannel({ AuthChannel: 'SMS', Phone: '73007552' }) === 'email');
}

// ---------------- effectiveAuthChannel ----------------
{
  const ctx = makeCtx({});
  ok('effective channel is email when no sender exists, whatever is stored',
    ctx.effectiveAuthChannel({ AuthChannel: 'sms', Phone: '73007552' }) === 'email');
  ok('effective channel of a blank row is email', ctx.effectiveAuthChannel({}) === 'email');
  ok('effectiveAuthChannel tolerates no argument', ctx.effectiveAuthChannel() === 'email');
}

// ---------------- the three message variants are untouched ----------------
// A refactor must not quietly reword a security email.
const EXPECTED_SUBJECTS = [
  "subject = 'Your Mwakete password reset code';",
  "subject = 'Confirm two-factor authentication for Mwakete';",
  "subject = 'Your Mwakete login code';"
];
for (const line of EXPECTED_SUBJECTS) {
  ok('email subject unchanged: ' + line.slice(11, 45), auth.indexOf(line) !== -1, line);
}
const EXPECTED_BODY_FRAGMENTS = [
  "Your password reset code is: ",
  "Enter this code on the password reset page to choose a new password.",
  "Your verification code is: ",
  "Enter this code to finish turning on two-factor authentication for your store account.",
  "Your login code is: ",
  "If this was not you, someone may have your password - consider resetting it."
];
for (const f of EXPECTED_BODY_FRAGMENTS) {
  ok('email body fragment kept: "' + f.slice(0, 40) + '"', auth.indexOf(f) !== -1, f);
}

// ---------------- every purpose gets its own SMS copy ----------------
const issue = auth.slice(auth.indexOf('function issueTwoFACode'),
                         auth.indexOf('function consumeTwoFACode'));
ok('all three purposes set an smsBody',
  (issue.match(/smsBody = /g) || []).length === 3,
  String((issue.match(/smsBody = /g) || []).length));
ok('the SMS copy is short enough to be one message',
  ['Mwakete password reset code: ', 'Mwakete 2FA setup code: ', 'Mwakete login code: ']
    .every((f) => issue.indexOf(f) !== -1));
ok('issueTwoFACode routes through sendAuthCode, not sendAppEmail directly',
  issue.indexOf('sendAuthCode(') !== -1 && issue.indexOf('sendAppEmail(') === -1);

// ---------------- the extra argument is optional ----------------
ok('issueTwoFACode takes an optional owner row',
  /function issueTwoFACode\(ownerId, email, storeName, purpose, ownerRow\)/.test(auth));
ok('a call with no row still works - no bare ownerRow.Phone dereference',
  issue.indexOf('ownerRow ? ownerRow.Phone') !== -1);
ok('all three call sites now pass the row',
  (auth.match(/issueTwoFACode\(owner\.OwnerId, owner\.Email, owner\.StoreName, '\w+', owner\)/g) || []).length === 3,
  String((auth.match(/issueTwoFACode\(owner\.OwnerId[^)]*owner\)/g) || []).length));

// ---------------- the sheet column ----------------
const updStart = products.indexOf('function actionUpdateOwnerProfile');
const updEnd = products.indexOf('\nfunction ', updStart + 1);
const upd = products.slice(updStart, updEnd === -1 ? products.length : updEnd);

ok('ensureColumn runs BEFORE the write, or the value is silently dropped',
  upd.indexOf("ensureColumn(sheet, 'AuthChannel')") !== -1 &&
  upd.indexOf("ensureColumn(sheet, 'AuthChannel')") < upd.indexOf('updateRowFromObject(sheet,'));
ok('the save path accepts authChannel', /body\.authChannel !== undefined/.test(upd));
ok('only email or sms can reach the sheet - it is read back as a switch',
  /channel !== 'email' && channel !== 'sms'/.test(upd));
ok('nothing in this change deletes or renames a column',
  !/deleteColumn|removeColumn/.test(upd));

// ---------------- what the profile exposes ----------------
const grab = (src, name) => {
  const i = src.indexOf('function ' + name);
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j === -1 ? src.length : j);
};
const pubOwner = grab(auth, 'publicOwnerFields');
const pubStore = grab(auth, 'publicStoreFields');
ok('the authenticated profile carries authChannel', /authChannel: owner\.AuthChannel/.test(pubOwner));
ok('and what it would ACTUALLY use', /authChannelEffective: effectiveAuthChannel\(owner\)/.test(pubOwner));
ok('a SHOPPER never learns how a seller logs in',
  !/authChannel/.test(pubStore), 'authChannel leaked into publicStoreFields');

// ---------------- deploy hygiene ----------------
const code = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
const mainCode = require('child_process')
  .execSync('git -C ' + REPO + ' show origin/main:apps-script/Code.gs', { encoding: 'utf8' });
const ver = (t) => (t.match(/var APP_VERSION = '([^']+)'/) || [])[1];
// The bump is only OWED when a .gs file actually differs from main. Written as
// an unconditional "must differ", this fires the moment the branch merges -
// tree and main both at the same version, nothing left to bump - and on any
// later frontend-only branch, which is a false alarm rather than a regression.
const gsChanged = require('child_process')
  .execSync("git -C /home/user/simple-kiri-shop diff --name-only origin/main -- 'apps-script/*.gs'",
    { encoding: 'utf8' })
  .split('\n').filter(Boolean);
ok(gsChanged.length ? 'APP_VERSION bumped, because .gs files differ from main'
                    : 'no APP_VERSION bump owed - no .gs file differs from main',
  gsChanged.length === 0 || ver(code) !== ver(mainCode),
  gsChanged.length + ' changed | ' + ver(mainCode) + ' -> ' + ver(code));

console.log('\n--- Auth-code channel router ---');
let f = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
