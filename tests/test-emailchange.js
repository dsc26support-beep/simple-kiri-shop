/**
 * Changing a store's contact email, run against the REAL .gs sources.
 *
 * WHY THIS IS A SECURITY TEST, NOT A FEATURE TEST.
 *
 * That one address is three things at once: where customer orders are emailed
 * (Orders.gs), where password-reset codes go (actionRequestPasswordReset) and
 * where login 2FA codes go (actionLoginOwner). Until this change a live session
 * could repoint all three in a single Save with no proof of anything - so
 * anyone who got into a session once could make it permanent and lock the real
 * owner out of their own store.
 *
 * Three separate guarantees, each closing a different hole, and each asserted
 * here:
 *
 *   the password        PREVENTS the takeover - a stolen session is no longer
 *                       enough, and guessing is throttled by the same lockout
 *                       the login form uses.
 *   a code to the NEW   proves the address is real and readable, so a typo
 *     address           cannot silently swallow a store's orders.
 *   a warning to the    is the only thing the real owner ever sees if the other
 *     OLD address       two are in someone else's hands. Sent whether or not
 *                       the change is ever confirmed.
 *
 * And the one that is easy to forget: the live address must NOT move until the
 * code comes back. A seller who starts this and wanders off has to keep
 * receiving their orders.
 */
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
const utils = fs.readFileSync(REPO + 'apps-script/Utils.gs', 'utf8');
const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const code = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');

const grab = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}'));
  if (!m) throw new Error('could not find ' + name);
  return m[0];
};

function makeSandbox(opts) {
  opts = opts || {};
  const OWNERS = [
    { __row: 2, OwnerId: 'o1', Username: 'bong', StoreName: 'Bong Store',
      Email: 'old@example.com', PendingEmail: opts.pendingEmail || '',
      PasswordSalt: 'salt1', PasswordHash: 'salt1::rightpass', Status: 'active' },
    { __row: 3, OwnerId: 'o2', Username: 'other', StoreName: 'Other Store',
      Email: 'taken@example.com', PendingEmail: '', PasswordSalt: 'salt2',
      PasswordHash: 'salt2::whatever', Status: 'active' }
  ];
  const headers = { Owners: ['OwnerId', 'Username', 'StoreName', 'Email', 'PendingEmail',
    'PasswordSalt', 'PasswordHash', 'Status'] };
  if (opts.noPendingColumn) headers.Owners = headers.Owners.filter((h) => h !== 'PendingEmail');

  const sent = [];        // sendAppEmail calls
  const codes = [];       // issueTwoFACode calls
  const attempts = [];    // checkAndRecordLoginAttempt calls
  const writes = [];

  const sandbox = {
    console,
    ok: (o) => Object.assign({ ok: true }, o),
    fail: (e) => ({ ok: false, error: e }),
    getSheet: (n) => n,
    getHeaders: (n) => headers[n].slice(),
    sheetToObjects: (n) => (n === 'Owners' ? OWNERS : []).map((r) => Object.assign({}, r)),
    findRowById: (n, f, v) => (n === 'Owners' ? OWNERS : []).filter((r) => String(r[f]) === String(v))[0] || null,
    updateRowFromObject: (sheetName, row, obj) => {
      writes.push({ sheet: sheetName, row, obj: Object.assign({}, obj) });
      const target = OWNERS.filter((r) => r.__row === row)[0];
      if (target) Object.keys(obj).forEach((k) => {
        // Mirrors the real helper: a key with no header column is DROPPED.
        if (headers[sheetName].indexOf(k) !== -1) target[k] = obj[k];
      });
    },
    ensureColumn: (sheetName, name) => {
      if (headers[sheetName].indexOf(name) === -1) headers[sheetName].push(name);
    },
    // Deterministic stand-in with the same shape: salt-dependent, so a hash
    // made with one salt never matches another.
    hashPassword: (password, salt) => salt + '::' + password,
    checkAndRecordLoginAttempt: (username, succeeded) => {
      attempts.push({ username, succeeded });
      return opts.locked ? { locked: true, retryAfterMinutes: 7 } : { locked: false };
    },
    issueTwoFACode: (ownerId, email, storeName, purpose, ownerRow) => {
      codes.push({ ownerId, email, storeName, purpose });
      return { token: 'verify-token-1' };
    },
    consumeTwoFACode: (token, codeStr, purpose, ownerId) => {
      codes.push({ consumed: { token, code: codeStr, purpose, ownerId } });
      return opts.codeOk === false
        ? { ok: false, error: 'That code is not right' }
        : { ok: true, ownerId: ownerId };
    },
    sendAppEmail: (to, subject, body) => { sent.push({ to, subject, body }); return true; },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    EMAIL_FORMAT_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  };
  vm.createContext(sandbox);
  vm.runInContext([
    grab(utils, 'capLength'),
    grab(utils, 'constantTimeEquals'),
    grab(auth, 'validateOwnerEmail'),
    grab(auth, 'actionRequestEmailChange'),
    grab(auth, 'actionConfirmEmailChange')
  ].join('\n'), sandbox);

  return { sandbox, OWNERS, sent, codes, attempts, writes, headers };
}

const OWNER = () => ({ OwnerId: 'o1', Username: 'bong', StoreName: 'Bong Store',
  Email: 'old@example.com', PasswordSalt: 'salt1', PasswordHash: 'salt1::rightpass' });

/* ---------- the password is required, and guessing is throttled ---------- */
{
  const { sandbox, OWNERS, sent, codes, attempts } = makeSandbox();
  const res = sandbox.actionRequestEmailChange(OWNER(), { email: 'new@example.com', password: 'wrongpass' });
  ok('a wrong password is refused', res.ok === false, res.error);
  ok('and the live email is untouched', OWNERS[0].Email === 'old@example.com');
  ok('nothing is left pending', !OWNERS[0].PendingEmail, String(OWNERS[0].PendingEmail));
  ok('no code is sent anywhere', codes.length === 0);
  ok('and the old address is not spammed by a failed guess', sent.length === 0);
  ok('the failed attempt is recorded against the lockout', attempts.length === 1
    && attempts[0].succeeded === false && attempts[0].username === 'bong', JSON.stringify(attempts));
}
{
  const { sandbox } = makeSandbox({ locked: true });
  const res = sandbox.actionRequestEmailChange(OWNER(), { email: 'new@example.com', password: 'rightpass' });
  ok('a locked-out account is refused even with the right password', res.ok === false, res.error);
  ok('and is told how long to wait', /7 minute/.test(res.error), res.error);
}
{
  const { sandbox, codes } = makeSandbox();
  const res = sandbox.actionRequestEmailChange(OWNER(), { email: 'new@example.com', password: '' });
  ok('no password at all is refused', res.ok === false, res.error);
  ok('and it says why', /password/i.test(res.error), res.error);
  ok('with no code issued', codes.length === 0);
}

/* ---------- the address itself has to make sense ------------------------- */
{
  const { sandbox } = makeSandbox();
  ok('a malformed address is refused',
    sandbox.actionRequestEmailChange(OWNER(), { email: 'not-an-email', password: 'rightpass' }).ok === false);
  ok('a blank address is refused',
    sandbox.actionRequestEmailChange(OWNER(), { email: '', password: 'rightpass' }).ok === false);
  const taken = sandbox.actionRequestEmailChange(OWNER(), { email: 'taken@example.com', password: 'rightpass' });
  ok('an address another store already uses is refused', taken.ok === false, taken.error);
  ok('and says so plainly', /already registered/i.test(taken.error), taken.error);
  const same = sandbox.actionRequestEmailChange(OWNER(), { email: 'OLD@example.com', password: 'rightpass' });
  ok('their own current address is refused, whatever the capitals', same.ok === false, same.error);
}

/* ---------- the happy path: nothing moves yet ---------------------------- */
{
  const { sandbox, OWNERS, sent, codes } = makeSandbox();
  const res = sandbox.actionRequestEmailChange(OWNER(), { email: ' New@Example.com ', password: 'rightpass' });
  ok('a correct password starts the change', res.ok === true, res.error);
  ok('and hands back a token to confirm with', res.verifyToken === 'verify-token-1', res.verifyToken);
  ok('it says where the code went', res.sentTo === 'New@Example.com', res.sentTo);

  ok('THE LIVE EMAIL HAS NOT CHANGED', OWNERS[0].Email === 'old@example.com', OWNERS[0].Email);
  ok('the new address is held aside instead', OWNERS[0].PendingEmail === 'New@Example.com',
    String(OWNERS[0].PendingEmail));

  const issued = codes.filter((c) => c.purpose === 'emailchange')[0];
  ok('a code is issued for THIS purpose', !!issued, JSON.stringify(codes));
  ok('and sent to the NEW address, not the old one', issued && issued.email === 'New@Example.com',
    issued && issued.email);
  ok('tied to this owner', issued && issued.ownerId === 'o1');

  const warning = sent[0];
  ok('the OLD address is warned', !!warning && warning.to === 'old@example.com',
    JSON.stringify(sent.map((s) => s.to)));
  ok('the warning names the address being switched to', warning && /New@Example\.com/.test(warning.body),
    warning && warning.body);
  ok('and tells them what to do if it was not them',
    warning && /was not you/i.test(warning.body) && /password/i.test(warning.body));
  ok('it also says nothing has changed yet, so a real owner is not panicked',
    warning && /still using this address/i.test(warning.body), warning && warning.body);
}

/* ---------- confirming ---------------------------------------------------- */
{
  const { sandbox, OWNERS, codes } = makeSandbox({ pendingEmail: 'new@example.com' });
  const res = sandbox.actionConfirmEmailChange(OWNER(), { verifyToken: 'verify-token-1', code: '123456' });
  ok('a good code applies the change', res.ok === true, res.error);
  ok('the live email is now the new one', OWNERS[0].Email === 'new@example.com', OWNERS[0].Email);
  ok('and nothing is left pending', OWNERS[0].PendingEmail === '', String(OWNERS[0].PendingEmail));
  const consumed = codes.filter((c) => c.consumed)[0].consumed;
  ok('the code was checked for THIS purpose', consumed.purpose === 'emailchange', consumed.purpose);
  // Without this, one seller's code could apply another seller's pending change.
  ok('and against THIS owner', consumed.ownerId === 'o1', consumed.ownerId);
}
{
  const { sandbox, OWNERS } = makeSandbox({ pendingEmail: 'new@example.com', codeOk: false });
  const res = sandbox.actionConfirmEmailChange(OWNER(), { verifyToken: 'verify-token-1', code: '000000' });
  ok('a bad code changes nothing', res.ok === false, res.error);
  ok('the live email stays put', OWNERS[0].Email === 'old@example.com');
  ok('and the pending address survives, so they can try the code again',
    OWNERS[0].PendingEmail === 'new@example.com', String(OWNERS[0].PendingEmail));
}
{
  const { sandbox, OWNERS } = makeSandbox();   // nothing pending
  const res = sandbox.actionConfirmEmailChange(OWNER(), { verifyToken: 'verify-token-1', code: '123456' });
  ok('a code with no request behind it does nothing', res.ok === false, res.error);
  ok('and says to start again', /start again/i.test(res.error), res.error);
  ok('the live email is untouched', OWNERS[0].Email === 'old@example.com');
}
{
  // Someone else registered that address in the minutes between the two steps.
  const { sandbox, OWNERS } = makeSandbox({ pendingEmail: 'taken@example.com' });
  const res = sandbox.actionConfirmEmailChange(OWNER(), { verifyToken: 'verify-token-1', code: '123456' });
  ok('an address taken since the request is refused at confirm time', res.ok === false, res.error);
  ok('the live email is untouched', OWNERS[0].Email === 'old@example.com');
  ok('and the dead request is cleared rather than left to fail forever',
    OWNERS[0].PendingEmail === '', String(OWNERS[0].PendingEmail));
}

/* ---------- an older sheet with no PendingEmail column -------------------- */
{
  const { sandbox, OWNERS, headers } = makeSandbox({ noPendingColumn: true });
  const res = sandbox.actionRequestEmailChange(OWNER(), { email: 'new@example.com', password: 'rightpass' });
  ok('a sheet predating the column still works', res.ok === true, res.error);
  ok('because the column is created first', headers.Owners.indexOf('PendingEmail') !== -1,
    headers.Owners.join(','));
  ok('and the pending address actually lands', OWNERS[0].PendingEmail === 'new@example.com',
    String(OWNERS[0].PendingEmail));
}

/* ---------- the old, unverified path is really gone ---------------------- */
{
  const fn = grab(products, 'actionUpdateOwnerProfile');
  ok('Save Settings can no longer write the email at all',
    !/update\.Email\s*=/.test(fn), (fn.match(/update\.Email[^\n]*/) || [''])[0]);
  ok('and it says why, so nobody adds it back as a convenience',
    /own two-step path|actionRequestEmailChange/.test(fn));
  // Ignored rather than refused: an older cached build still sends body.email
  // on every Save, and failing the whole save would break phone, logo and
  // delivery edits for anyone who has not picked up the new build.
  ok('an email sent by an old build does not break the rest of the save',
    !/body\.email/.test(fn) || /ignored/.test(fn));

  ok('both actions are routed', /case 'requestEmailChange'/.test(code) && /case 'confirmEmailChange'/.test(code));
  // They must sit in the authenticated block - the one that resolves an owner
  // from a session token - not among the public actions.
  const protectedBlock = code.slice(code.indexOf('PROTECTED') >= 0 ? code.indexOf('PROTECTED') : 0);
  ok('and routed where an owner has already been authenticated',
    /requireAuth|PROTECTED/.test(code) && protectedBlock.indexOf("case 'requestEmailChange'") !== -1);

  ok('the pending state is reported back to the page',
    /pendingEmail: owner\.PendingEmail/.test(auth));
  ok('the new purpose has its own message',
    /purpose === 'emailchange'/.test(auth) && /Confirm your new Mwakete store email/.test(auth));

  const settingsJs = fs.readFileSync(REPO + 'assets/js/owner-settings.js', 'utf8');
  const payload = settingsJs.match(/const payload = \{[\s\S]*?\};/)[0];
  ok('the settings page no longer sends an email with its save', !/email:/.test(payload), payload);
  ok('it uses the two-step actions instead',
    /requestEmailChange/.test(settingsJs) && /confirmEmailChange/.test(settingsJs));
  const settingsHtml = fs.readFileSync(REPO + 'owner/settings.html', 'utf8');
  ok('and the email is no longer an editable box on that form',
    !/<input id="contact-email"/.test(settingsHtml));
}

let f = 0;
console.log('\n--- Changing a store contact email ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
