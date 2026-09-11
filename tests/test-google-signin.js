// Google Sign-In token verification, run against the REAL CustomerOAuth.gs.
//
// This suite exists for one reason: every check in verifyGoogleIdToken is
// load-bearing, and dropping any of them makes the endpoint forgeable. The
// `aud` check is the one that matters most - without it, an ID token minted
// for ANY other Google app would be accepted here and would hand over a
// Mwakete account. So each check gets a test that FAILS if the check is
// removed, not just a happy-path test.
//
// Google itself is never contacted. UrlFetchApp is stubbed, which is what lets
// a forged response be fed in deliberately.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const oauth = fs.readFileSync(REPO + 'apps-script/CustomerOAuth.gs', 'utf8');

const REAL_CLIENT = '111-abc.apps.googleusercontent.com';
const future = () => Math.floor(Date.now() / 1000) + 3600;

function goodClaims(over) {
  return Object.assign({
    aud: REAL_CLIENT,
    iss: 'https://accounts.google.com',
    exp: String(future()),
    email: 'Aroita@Example.com ',
    email_verified: 'true',
    name: 'Aroita T',
    sub: 'google-uid-1'
  }, over || {});
}

// Builds a sandbox where Google's tokeninfo returns exactly `claims`.
function makeCtx(opts) {
  opts = opts || {};
  const calls = { fetched: [] };
  const ctx = {
    String, Number, Boolean, JSON, Date, Math, encodeURIComponent,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => ('clientId' in opts ? opts.clientId : REAL_CLIENT)
      })
    },
    UrlFetchApp: {
      fetch: (url) => {
        calls.fetched.push(url);
        if (opts.throwOnFetch) throw new Error('network down');
        return {
          getResponseCode: () => (opts.status === undefined ? 200 : opts.status),
          getContentText: () => (opts.raw !== undefined ? opts.raw : JSON.stringify(opts.claims || goodClaims()))
        };
      }
    },
    fail: (msg) => ({ ok: false, error: msg }),
    ok: (data) => Object.assign({ ok: true }, data),
    __calls: calls
  };
  vm.createContext(ctx);
  vm.runInContext(oauth, ctx);
  return ctx;
}

// ---------------- the aud check: the one that must never be dropped ---------
{
  const ctx = makeCtx({ claims: goodClaims({ aud: '999-someone-elses.apps.googleusercontent.com' }) });
  const res = ctx.verifyGoogleIdToken('tok');
  ok('a token minted for a DIFFERENT Google app is refused', res.ok === false, JSON.stringify(res));
}
{
  const ctx = makeCtx({ claims: goodClaims() });
  const res = ctx.verifyGoogleIdToken('tok');
  ok('a token for THIS app is accepted', res.ok === true, JSON.stringify(res));
}

// ---------------- fails closed when unconfigured ----------------------------
{
  const ctx = makeCtx({ clientId: null });
  const res = ctx.verifyGoogleIdToken('tok');
  ok('with no GOOGLE_CLIENT_ID set it refuses rather than allows', res.ok === false, JSON.stringify(res));
  ok('and it never even calls Google', ctx.__calls.fetched.length === 0);
}

// ---------------- issuer, expiry, verified email ----------------------------
{
  const ctx = makeCtx({ claims: goodClaims({ iss: 'https://evil.example.com' }) });
  ok('a token from a foreign issuer is refused', ctx.verifyGoogleIdToken('tok').ok === false);
}
{
  const ctx = makeCtx({ claims: goodClaims({ exp: String(Math.floor(Date.now() / 1000) - 60) }) });
  ok('an expired token is refused', ctx.verifyGoogleIdToken('tok').ok === false);
}
{
  const ctx = makeCtx({ claims: goodClaims({ email_verified: 'false' }) });
  const res = ctx.verifyGoogleIdToken('tok');
  ok('an UNVERIFIED Google email is refused', res.ok === false, JSON.stringify(res));
}
{
  // The reason the check above matters, stated as its own assertion: an
  // unverified address must never be able to match an existing account,
  // because matching is what hands over that person's order history.
  const ctx = makeCtx({ claims: goodClaims({ email_verified: undefined }) });
  ok('a MISSING email_verified claim is refused too, not treated as true',
    ctx.verifyGoogleIdToken('tok').ok === false);
}
{
  const ctx = makeCtx({ claims: goodClaims({ email: '' }) });
  ok('a token with no email is refused', ctx.verifyGoogleIdToken('tok').ok === false);
}

// ---------------- transport failures never become a sign-in ----------------
{
  const ctx = makeCtx({ status: 400, raw: '{"error":"invalid_token"}' });
  ok('a non-200 from Google is refused', ctx.verifyGoogleIdToken('tok').ok === false);
}
{
  const ctx = makeCtx({ raw: 'not json at all' });
  ok('an unparseable response is refused', ctx.verifyGoogleIdToken('tok').ok === false);
}
{
  const ctx = makeCtx({ throwOnFetch: true });
  const res = ctx.verifyGoogleIdToken('tok');
  ok('a network failure is refused, and says so in plain words', res.ok === false && /try again/i.test(res.error), res.error);
}
{
  const ctx = makeCtx({});
  ok('an empty credential is refused before any network call',
    ctx.verifyGoogleIdToken('').ok === false && ctx.__calls.fetched.length === 0);
}

// ---------------- the token is sent url-encoded ----------------------------
{
  const ctx = makeCtx({});
  ctx.verifyGoogleIdToken('a b&c=d');
  const url = ctx.__calls.fetched[0] || '';
  ok('the credential is url-encoded into the query', url.indexOf('a%20b%26c%3Dd') !== -1, url);
}

// ---------------- error messages must not leak which check failed ----------
{
  const wrongAud = makeCtx({ claims: goodClaims({ aud: 'other' }) }).verifyGoogleIdToken('t').error;
  const wrongIss = makeCtx({ claims: goodClaims({ iss: 'other' }) }).verifyGoogleIdToken('t').error;
  ok('a wrong audience and a wrong issuer give the SAME message',
    wrongAud === wrongIss, wrongAud + ' | ' + wrongIss);
}

// ---------------- vendor auth is not touched by any of this ----------------
{
  ok('CustomerOAuth.gs never references the Owners sheet', !/['"]Owners['"]/.test(oauth));
  ok('and never issues an owner session', !/issueSession\s*\(/.test(oauth));
  ok('and never touches 2FA', !/TwoFA|twoFactor/i.test(oauth));
  const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
  ok('Auth.gs has no Google path at all', !/google/i.test(auth));
}

// ---------------- session lifetimes ----------------------------------------
{
  const customers = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
  ok('a remembered session is 60 days', /CUSTOMER_REMEMBER_HOURS\s*=\s*24\s*\*\s*60/.test(customers));
  ok('a shared-device session is much shorter', /CUSTOMER_SHARED_DEVICE_HOURS\s*=\s*12\b/.test(customers));
  const calls = customers.match(/issueCustomerSession\(customer\.CustomerId[^)]*\)/g) || [];
  ok('every email-code sign-in passes the shared-device choice through',
    calls.length === 2 && calls.every((c) => c.indexOf('sharedDevice') !== -1), JSON.stringify(calls));
}

let pass = 0;
for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
