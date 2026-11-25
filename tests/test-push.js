/**
 * CESN Stage 3 - Push.gs. Standalone vm with the Apps Script services Push.gs
 * uses stubbed (no Google). Proves: dormant without a service account;
 * registration upserts/dedupes by token; a send fans out to active devices,
 * mints an OAuth token once, and prunes a token FCM reports as gone.
 */
const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Push.gs', 'utf8');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  [' + JSON.stringify(e) + ']' : '')); } };

// fcmResponder: token -> { code, body }. oauth2 always returns a token unless
// opts.noOAuth. Records the outbound FCM calls.
function makeEnv(opts) {
  opts = opts || {};
  const props = Object.assign({ SITE_BASE_URL: 'https://mwakete.example' }, opts.props || {});
  const tables = { PushSubscriptions: (opts.subs || []).slice() };
  let n = 0;
  const fcmCalls = [];
  const sandbox = {
    JSON, Math, Date, String, Number, Object, Array, encodeURIComponent,
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: String(e) }),
    newId: (p) => p + '_' + (++n),
    nowIso: () => new Date(2026, 10, 25).toISOString(),
    publicErrorMessage: (e) => (e && e.message) || String(e),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: {
      base64EncodeWebSafe: (s) => Buffer.from(typeof s === 'string' ? s : Buffer.from(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeRsaSha256Signature: () => [1, 2, 3]
    },
    UrlFetchApp: { fetch: (url, params) => {
      if (/oauth2\.googleapis\.com/.test(url)) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(opts.noOAuth ? {} : { access_token: 'at-123' }) };
      }
      // FCM send: pull the token out of the payload and look up the scripted reply.
      const body = JSON.parse(params.payload);
      const tok = body.message.token;
      fcmCalls.push(tok);
      const r = (opts.fcm && opts.fcm[tok]) || { code: 200, body: '{}' };
      return { getResponseCode: () => r.code, getContentText: () => r.body || '' };
    } },
    getSheet: (name) => { if (!(name in tables)) throw new Error('no tab ' + name); return name; },
    sheetToObjects: (name) => tables[name].map((r, i) => { r.__row = i; return r; }),
    appendRowFromObject: (name, obj) => { tables[name].push(Object.assign({}, obj)); },
    updateRowFromObject: (name, row, patch) => { Object.assign(tables[name][row], patch); },
    requireCustomerAuth: (tok) => { if (tok !== 'tokC') throw new Error('Not signed in'); return { CustomerId: 'cus_1', Email: 'c@x.test' }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, tables, fcmCalls };
}
const call = (env, fn, ...args) => { try { return vm.runInContext('(' + fn + ')', env.sandbox)(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; } };

const SA = JSON.stringify({ client_email: 'svc@proj.iam', private_key: 'KEY', project_id: 'proj-1' });

/* ---- dormant without a service account ---- */
{
  const env = makeEnv();
  t('pushEnabled() false when FCM_SERVICE_ACCOUNT unset', call(env, 'pushEnabled') === false);
  const r = call(env, 'sendPushToCustomer', 'cus_1', { title: 'Hi' });
  t('send is a no-op when disabled', r.skipped === 'disabled' && r.sent === 0 && env.fcmCalls.length === 0, r);
  // registration still works (records the token) even while disabled
  const rr = call(env, 'actionRegisterPushSubscription', { token: 'tokC', fcmToken: 'DEV1', platform: 'web' });
  t('register records a token even while push is disabled', rr.ok && rr.registered && rr.pushEnabled === false && env.tables.PushSubscriptions.length === 1, rr);
}

/* ---- registration upsert + dedupe + auth ---- */
{
  const env = makeEnv({ props: { FCM_SERVICE_ACCOUNT: SA } });
  t('register requires auth', call(env, 'actionRegisterPushSubscription', { fcmToken: 'D' }).ok === false);
  t('register requires a token', call(env, 'actionRegisterPushSubscription', { token: 'tokC' }).ok === false);
  let r = call(env, 'actionRegisterPushSubscription', { token: 'tokC', fcmToken: 'DEV1', userAgent: 'UA', platform: 'web' });
  t('register: ok and pushEnabled true now', r.ok && r.pushEnabled === true && env.tables.PushSubscriptions.length === 1);
  call(env, 'actionRegisterPushSubscription', { token: 'tokC', fcmToken: 'DEV1', platform: 'web2' });
  t('register same token again: upsert, still 1 row, platform updated',
    env.tables.PushSubscriptions.length === 1 && env.tables.PushSubscriptions[0].Platform === 'web2' && env.tables.PushSubscriptions[0].Status === 'active');
  call(env, 'actionRegisterPushSubscription', { token: 'tokC', fcmToken: 'DEV2', platform: 'web' });
  t('a second device adds a second row', env.tables.PushSubscriptions.length === 2);
  r = call(env, 'actionUnregisterPushSubscription', { token: 'tokC', fcmToken: 'DEV2' });
  t('unregister marks that device disabled', r.ok && env.tables.PushSubscriptions[1].Status === 'disabled');
}

/* ---- send fans out to active devices, prunes a gone token ---- */
{
  const env = makeEnv({
    props: { FCM_SERVICE_ACCOUNT: SA },
    subs: [
      { SubId: 's1', CustomerId: 'cus_1', FcmToken: 'GOOD', Status: 'active' },
      { SubId: 's2', CustomerId: 'cus_1', FcmToken: 'DEAD', Status: 'active' },
      { SubId: 's3', CustomerId: 'cus_1', FcmToken: 'OFF', Status: 'disabled' },
      { SubId: 's4', CustomerId: 'cus_2', FcmToken: 'OTHER', Status: 'active' }
    ],
    fcm: { GOOD: { code: 200, body: '{}' }, DEAD: { code: 404, body: '{"error":{"status":"UNREGISTERED"}}' } }
  });
  const r = call(env, 'sendPushToCustomer', 'cus_1', { title: 'Offer', body: '10% off', deepLink: 'store.html?store=bong' });
  t('send: only this customer’s active devices are contacted', env.fcmCalls.sort().join(',') === 'DEAD,GOOD', env.fcmCalls);
  t('send: 1 delivered, 1 pruned', r.sent === 1 && r.pruned === 1, r);
  t('send: the dead token is marked unregistered', env.tables.PushSubscriptions[1].Status === 'unregistered');
  t('send: the good token stays active', env.tables.PushSubscriptions[0].Status === 'active');
  t('send: the other customer’s device was never touched', env.fcmCalls.indexOf('OTHER') === -1);
}

/* ---- no OAuth token -> graceful skip, nothing pruned ---- */
{
  const env = makeEnv({ props: { FCM_SERVICE_ACCOUNT: SA }, noOAuth: true, subs: [{ SubId: 's1', CustomerId: 'cus_1', FcmToken: 'GOOD', Status: 'active' }] });
  const r = call(env, 'sendPushToCustomer', 'cus_1', { title: 'Hi' });
  t('send: missing OAuth token -> skipped, no FCM calls, nothing pruned', r.skipped === 'no-token' && env.fcmCalls.length === 0 && env.tables.PushSubscriptions[0].Status === 'active', r);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
