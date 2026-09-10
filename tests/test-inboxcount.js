// actionGetCustomerInbox: unread counting, run against the REAL Chat.gs source.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const SHEETS = {
  Conversations: [
    { ConversationId: 'c1', StoreSlug: 'bong', CustomerToken: 'tok-a', Status: 'open',
      LastMessagePreview: 'See you then', LastMessageAt: '2026-09-05T10:00:00Z', LastSenderType: 'vendor' },
    { ConversationId: 'c2', StoreSlug: 'teaube', CustomerToken: 'tok-b', Status: 'open',
      LastMessagePreview: 'Thanks!', LastMessageAt: '2026-09-04T10:00:00Z', LastSenderType: 'customer' },
    // Someone else's thread on a store this device also uses - same slug, other token.
    { ConversationId: 'c3', StoreSlug: 'bong', CustomerToken: 'tok-SOMEONE-ELSE', Status: 'open',
      LastMessagePreview: 'private', LastMessageAt: '2026-09-05T11:00:00Z', LastSenderType: 'vendor' },
    { ConversationId: 'c4', StoreSlug: 'gone', CustomerToken: 'tok-c', Status: 'deleted',
      LastMessagePreview: 'x', LastMessageAt: '2026-09-05T09:00:00Z', LastSenderType: 'vendor' }
  ],
  Messages: [
    // c1: three vendor messages after the mark, one before, one from the customer after.
    { ConversationId: 'c1', SenderType: 'vendor',   CreatedAt: '2026-09-05T08:00:00Z' },
    { ConversationId: 'c1', SenderType: 'vendor',   CreatedAt: '2026-09-05T09:30:00Z' },
    { ConversationId: 'c1', SenderType: 'vendor',   CreatedAt: '2026-09-05T09:45:00Z' },
    { ConversationId: 'c1', SenderType: 'vendor',   CreatedAt: '2026-09-05T10:00:00Z' },
    { ConversationId: 'c1', SenderType: 'customer', CreatedAt: '2026-09-05T09:50:00Z' },
    // c2: vendor messages, all before this device's mark.
    { ConversationId: 'c2', SenderType: 'vendor',   CreatedAt: '2026-09-04T08:00:00Z' },
    { ConversationId: 'c2', SenderType: 'vendor',   CreatedAt: '2026-09-04T09:00:00Z' },
    // c3 belongs to another device entirely and must never be counted or returned.
    { ConversationId: 'c3', SenderType: 'vendor',   CreatedAt: '2026-09-05T11:00:00Z' }
  ]
};

const OWNERS = {
  bong:   { StoreName: 'Bong Restaurant', LogoUrl: 'https://res.cloudinary.com/x/bong.jpg', Email: 'secret@x.com', TwoFAEnabled: true },
  teaube: { StoreName: 'Teaube Store', LogoUrl: '', Email: 'other@x.com' }
};

const sandbox = {
  console,
  ok: (o) => Object.assign({ ok: true }, o),
  fail: (e) => ({ ok: false, error: e }),
  getSheet: (name) => name,
  sheetToObjects: (name) => (SHEETS[name] || []).map((r) => Object.assign({}, r)),
  getOwnerBySlug: (slug) => OWNERS[slug] || null,
  // A REAL cache, not a pass-through, so the new inbox caching is exercised
  // rather than bypassed. cacheStore/cacheProduced let the tests assert both
  // that a repeat call is served from cache and that a different device is not.
  getCached: (k, ttl, fn) => {
    sandbox.cacheCalls.push(k);
    if (Object.prototype.hasOwnProperty.call(sandbox.cacheStore, k)) return sandbox.cacheStore[k];
    const v = fn();
    sandbox.cacheStore[k] = v;
    sandbox.cacheProduced.push(k);
    return v;
  },
  cacheStore: {}, cacheCalls: [], cacheProduced: [],
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    // Deterministic stand-in for the real digest. The tests only need distinct
    // inputs to give distinct keys, which is the property the cache relies on.
    computeDigest: (alg, text) => {
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < text.length; i++) {
        h1 = (h1 ^ text.charCodeAt(i)) * 16777619 >>> 0;
        h2 = (h2 + text.charCodeAt(i) * (i + 7)) >>> 0;
      }
      const out = [];
      for (let i = 0; i < 32; i++) out.push(((i % 2 ? h1 : h2) >>> ((i * 3) % 24)) & 0xff);
      return out;
    }
  },
  invalidateCache: () => {},
  findRowById: () => null,
  appendRowFromObject: () => {},
  newId: () => 'x',
  nowIso: () => new Date().toISOString(),
  touchConversationOnNewMessage: () => {},
  CHAT_SENDER_TYPES: ['customer', 'vendor'],
  MAX_CHAT_MESSAGE_LENGTH: 2000,
  CHAT_MESSAGES_CACHE_TTL_SECONDS: 10
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(REPO + 'apps-script/Chat.gs', 'utf8'), sandbox);

const SEEN = '2026-09-05T09:00:00Z'; // between c1's first and second vendor message

// ---- counts ----
let res = sandbox.actionGetCustomerInbox({ stores: [
  { storeSlug: 'bong', customerToken: 'tok-a', seenAt: SEEN },
  { storeSlug: 'teaube', customerToken: 'tok-b', seenAt: '2026-09-04T23:00:00Z' }
] });

ok('returns ok', res.ok === true, JSON.stringify(res).slice(0, 120));
const byStore = {};
(res.conversations || []).forEach((c) => { byStore[c.storeSlug] = c; });

ok('only this device\'s threads come back', (res.conversations || []).length === 2,
  JSON.stringify((res.conversations || []).map((c) => c.storeSlug)));
ok('another token\'s thread on the same store is NOT returned',
  !(res.conversations || []).some((c) => c.lastMessagePreview === 'private'));
ok('deleted conversations stay out',
  !(res.conversations || []).some((c) => c.storeSlug === 'gone'));

ok('counts only vendor messages newer than seenAt', byStore.bong.unreadCount === 3,
  'got ' + byStore.bong.unreadCount);
ok('the customer\'s own message is not unread', byStore.bong.unreadCount !== 4,
  'got ' + byStore.bong.unreadCount);
ok('a fully-read thread counts zero', byStore.teaube.unreadCount === 0,
  'got ' + byStore.teaube.unreadCount);

// ---- never seen ----
res = sandbox.actionGetCustomerInbox({ stores: [{ storeSlug: 'bong', customerToken: 'tok-a' }] });
ok('no seenAt means every vendor message is unread', res.conversations[0].unreadCount === 4,
  'got ' + res.conversations[0].unreadCount);
ok('an unparseable seenAt is treated as never seen',
  sandbox.actionGetCustomerInbox({ stores: [{ storeSlug: 'bong', customerToken: 'tok-a', seenAt: 'rubbish' }] })
    .conversations[0].unreadCount === 4);

// ---- the logo, and nothing more ----
res = sandbox.actionGetCustomerInbox({ stores: [
  { storeSlug: 'bong', customerToken: 'tok-a', seenAt: SEEN },
  { storeSlug: 'teaube', customerToken: 'tok-b', seenAt: SEEN }
] });
const bong = res.conversations.find((c) => c.storeSlug === 'bong');
const teaube = res.conversations.find((c) => c.storeSlug === 'teaube');
ok('store logo is returned', bong.storeLogoUrl === OWNERS.bong.LogoUrl, bong.storeLogoUrl);
ok('a store with no logo returns an empty string, not undefined', teaube.storeLogoUrl === '',
  JSON.stringify(teaube.storeLogoUrl));
ok('store name still returned', bong.storeName === 'Bong Restaurant', bong.storeName);

// The owner row carries email and 2FA state. Leaking either here would undo
// the publicStoreFields fix.
const leaked = Object.keys(bong).filter((k) => /email|twofa|ownerid|password|token/i.test(k));
ok('no owner secrets leak into the inbox payload', leaked.length === 0, leaked.join(','));
ok('the internal _seen scratch field is stripped', !('_seen' in bong), Object.keys(bong).join(','));

// ---- sorting and the empty case ----
ok('newest thread first', res.conversations[0].storeSlug === 'bong',
  res.conversations.map((c) => c.storeSlug).join(','));
ok('no stores means no conversations and no sheet reads',
  JSON.stringify(sandbox.actionGetCustomerInbox({ stores: [] })) === JSON.stringify({ ok: true, conversations: [] }));
ok('a store the device has no thread with is simply absent',
  sandbox.actionGetCustomerInbox({ stores: [{ storeSlug: 'nosuch', customerToken: 't', seenAt: SEEN }] })
    .conversations.length === 0);

// ---- inbox caching (new) ----
// This file uses one module-level sandbox, so the cache is cleared by hand
// rather than by rebuilding it.
{
  sandbox.cacheStore = {}; sandbox.cacheCalls = []; sandbox.cacheProduced = [];
  const req = { stores: [{ storeSlug: 'bong', customerToken: 'tok-a', seenAt: SEEN }] };
  const first = sandbox.actionGetCustomerInbox(req);
  const produced = sandbox.cacheProduced.length;
  const second = sandbox.actionGetCustomerInbox(req);
  ok('an identical repeat request is served from cache', sandbox.cacheProduced.length === produced,
    `${produced} -> ${sandbox.cacheProduced.length}`);
  ok('and returns the same answer', JSON.stringify(first) === JSON.stringify(second));

  sandbox.actionGetCustomerInbox({ stores: [{ storeSlug: 'bong', customerToken: 'tok-a', seenAt: '2026-09-05T00:00:00Z' }] });
  ok('a changed read-mark computes a different key', sandbox.cacheProduced.length === produced + 1,
    String(sandbox.cacheProduced.length));
  sandbox.actionGetCustomerInbox({ stores: [{ storeSlug: 'bong', customerToken: 'tok-OTHER-DEVICE', seenAt: SEEN }] });
  ok('another device computes a different key', sandbox.cacheProduced.length === produced + 2,
    String(sandbox.cacheProduced.length));
  ok('no raw chat token appears in any cache key',
    sandbox.cacheCalls.every((k) => k.indexOf('tok-') === -1), sandbox.cacheCalls.join(' '));
  ok('an empty request never touches the cache',
    JSON.stringify(sandbox.actionGetCustomerInbox({ stores: [] })) === JSON.stringify({ ok: true, conversations: [] }));
}

// ---- APP_VERSION must move when the backend does ----
const { execSync } = require('child_process');
const verOf = (src) => (src.match(/APP_VERSION = '([^']+)'/) || [])[1];
const nowCode = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
const mainCode = execSync('git -C ' + REPO + ' show origin/main:apps-script/Code.gs').toString();
let anyGsChanged = false;
for (const f of fs.readdirSync(REPO + 'apps-script')) {
  if (!f.endsWith('.gs')) continue;
  const cur = fs.readFileSync(REPO + 'apps-script/' + f, 'utf8');
  let base = '';
  try { base = execSync(`git -C ${REPO} show origin/main:apps-script/${f}`).toString(); } catch (e) { base = ''; }
  if (cur !== base) anyGsChanged = true;
}
ok('an Apps Script change bumps APP_VERSION (deploy probe stays truthful)',
  !anyGsChanged || verOf(nowCode) !== verOf(mainCode), `${verOf(mainCode)} -> ${verOf(nowCode)}`);

let f = 0;
console.log('\n--- Inbox unread counting (real Chat.gs) ---');
for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
