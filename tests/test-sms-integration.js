/**
 * Contacts & SMS, stage 6: the three clients together against the REAL
 * backend (gas-harness doPost), plus a contract check of the Android app.
 *
 * 1. Contract. The Android app (Kotlin) cannot run here, so its SOURCE is read:
 *    every action it calls, every field it sends and every field it reads must
 *    be one the backend really uses / answers, its result statuses and error
 *    words must be ones the backend accepts, and its STOP words must match.
 *    A rename on either side fails this test instead of failing on a phone.
 * 2. Journey. A day in a store's life, each step by the client that does it:
 *    Google Sheet (add-on code) adds contacts and drafts a campaign ->
 *    Mwakete.com (store session) connects a phone and starts it -> the phone
 *    (a simulator that sends exactly the fields read from the Kotlin source)
 *    takes messages, reports sent / delivered / failed and a STOP reply ->
 *    the store retries the failure -> the Sheet pulls the results.
 *
 * Simulated phone, not a real SIM: real sending is the owner's phone test.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fails = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fails++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + String(e).slice(0, 400) + ']')); } };
const J = (x) => JSON.stringify(x);
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FUT = new Date(Date.now() + 86400000).toISOString();

/* =================== 1. the Android contract =================== */
const KT_DIR = 'android/app/src/main/java/com/mwakete/sms/';
const kt = {};
fs.readdirSync(path.join(ROOT, KT_DIR)).forEach((f) => { kt[f] = read(KT_DIR + f); });
const allKt = Object.values(kt).join('\n');
const coreKt = read('android/sms-core/src/main/kotlin/com/mwakete/sms/core/SmsCore.kt') + read('android/sms-core/src/main/kotlin/com/mwakete/sms/core/SenderRules.kt');
const gs = ['Code.gs', 'SmsDevices.gs', 'SmsCampaigns.gs', 'SmsCore.gs'].map((f) => read('apps-script/' + f)).join('\n');
const fnBody = (name) => { const m = gs.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}')); return m ? m[0] : ''; };
const putsIn = (src) => Array.from(src.matchAll(/\.put\("([a-zA-Z]+)"/g)).map((m) => m[1]);

// Actions
const actions = Array.from(allKt.matchAll(/Api\.call\("([a-zA-Z]+)"/g)).map((m) => m[1]);
ok('the app calls exactly the three device actions', J(actions.sort()) === J(['smsDeviceRotate', 'smsDeviceSync', 'smsPairDevice']), J(actions));
ok('...each is a public action routed by doPost', actions.every((a) => new RegExp("'" + a + "'").test(fnBody('doPost') + gs.match(/var PUBLIC_POST_ACTIONS[\s\S]*?\];/)[0]) && new RegExp("case '" + a + "'").test(gs)));
ok('...posted the way Apps Script reads it (text/plain JSON, action in the body, redirect followed by GET)',
  /text\/plain;charset=utf-8/.test(kt['Api.kt']) && /body\.put\("action", action\)/.test(kt['Api.kt']) && /requestMethod = "GET"/.test(kt['Api.kt']));

// What the app sends
const syncFn = kt['SyncWorker.kt'].match(/private fun sync\([\s\S]*?\n    }/)[0];
const syncSent = putsIn(syncFn);
const syncRead = fnBody('actionSmsDeviceSync');
ok('every field of the app\'s check-in is one the backend reads', syncSent.length >= 8 && syncSent.every((k) => syncRead.includes('body.' + k)), J(syncSent.filter((k) => !syncRead.includes('body.' + k))));
const simSent = putsIn(kt['Sims.kt']);
const simRead = fnBody('smsUpdateSims') + fnBody('smsSimKey');
ok('every SIM field the app sends is read', simSent.length === 6 && simSent.every((k) => simRead.includes('sim.' + k)), J(simSent.filter((k) => !simRead.includes('sim.' + k))));
const resultFn = kt['Store.kt'].match(/private fun addResultLocked[\s\S]*?\n    }/)[0];
const resultSent = putsIn(resultFn);
const resultRead = fnBody('smsApplyResults');
ok('every result field the app sends is read', J(resultSent.sort()) === J(['at', 'error', 'messageId', 'simKey', 'status']) && resultSent.every((k) => resultRead.includes('r.' + k)), J(resultSent));
const inboundSent = putsIn(kt['Store.kt'].match(/fun addInbound[\s\S]*?\n    }/)[0]);
ok('a STOP reply is sent as from + text (+ time), which the backend reads', inboundSent.includes('from') && inboundSent.includes('text') && /m\.from/.test(fnBody('smsApplyInbound')) && /m\.text/.test(fnBody('smsApplyInbound')));
const pairSent = putsIn(kt['MainActivity.kt'].match(/private fun pair\([\s\S]*?\n    }/)[0]);
ok('pairing sends code, model, app and Android version - all read', ['code', 'model', 'appVersion', 'androidVersion'].every((k) => pairSent.includes(k) && fnBody('actionSmsPairDevice').includes('body.' + k)), J(pairSent));

// Statuses and error words
const statuses = Array.from(allKt.matchAll(/addResult(?:Locked)?\([^,]+, "([a-z]+)"/g)).map((m) => m[1]);
ok('the app reports only statuses the backend accepts', statuses.length >= 3 && statuses.every((s) => ['submitted', 'sent', 'delivered', 'failed'].includes(s)), J(statuses));
const retryable = JSON.parse(gs.match(/var SMS_RETRYABLE_ERRORS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
const errorNameFn = coreKt.match(/fun errorName\([\s\S]*?\n    }/)[0];
const errorWords = Array.from(errorNameFn.matchAll(/-> "([a-z_]+)"/g)).map((m) => m[1]).concat(Array.from(allKt.matchAll(/failNow\([^,]+, "([a-z_]+)"/g)).map((m) => m[1]));
ok('Android send errors map to the backend\'s retryable words (bad_message is the only final one)',
  errorWords.filter((w) => w !== 'bad_message').every((w) => retryable.includes(w)) && errorWords.includes('sim_missing'), J(errorWords.filter((w) => !retryable.includes(w))));
const ktStop = JSON.parse('[' + coreKt.match(/STOP_WORDS\s*=\s*setOf\(([^)]*)\)/)[1] + ']').sort();
const gsStop = JSON.parse(gs.match(/var SMS_STOP_WORDS = (\[[^\]]*\])/)[1].replace(/'/g, '"')).sort();
ok('the app and the backend agree on STOP words', J(ktStop) === J(gsStop), J([ktStop, gsStop]));
ok('the app handles a revoked phone the backend\'s way (errorKind device_revoked)', /kind == "device_revoked"/.test(kt['SyncWorker.kt']) && /'device_revoked'/.test(fnBody('smsDeviceDenied')));

/* =================== 2. the journey =================== */
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'], ['own_a', 'a', 'A Shop', 'active', 'retailer', 'a@x.test'], ['own_b', 'b', 'B Shop', 'active', 'retailer', 'b@x.test']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT], ['tok-b', 'own_b', '', FUT]]
});
box.__props.CONTACTS_SMS = 'on';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.Logger = { log() {} };
const post = (b) => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s);
const web = (action, body) => post(Object.assign({ action, token: 'tok-a' }, body || {}));
const rows = (t) => (box.__sheets[t] ? box.smsRows(t) : []);

// ---- the Google Sheet (add-on source, in-memory sheet) ----
const sheets = {}; let active = null; let selection = [];
const mkSheet = (name, grid) => ({ name, grid: grid || [], getName: () => name, clear() { this.grid = []; }, setFrozenRows() {},
  getLastColumn() { return Math.max(0, ...this.grid.map((r) => r.length)); },
  getDataRange() { const g = this.grid; return { getValues: () => g.map((r) => r.slice()) }; },
  getRange(r, c, nr, nc) { const s = this; return { getRow: () => r, getNumRows: () => nr || 1,
    getValue: () => ((s.grid[r - 1] || [])[c - 1] ?? ''),
    getValues: () => [Array.from({ length: nc || 1 }, (_, j) => (s.grid[r - 1] || [])[c - 1 + j] ?? '')],
    setValues: (v) => v.forEach((row, i) => { s.grid[r - 1 + i] = row.map((x) => (typeof x === 'string' && x[0] === "'" ? x.slice(1) : x)); }) }; },
  getActiveRangeList: () => ({ getRanges: () => selection }) });
const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = mkSheet(n)), getActiveSheet: () => active, setActiveSheet: (s) => (active = s) };
const parseCsv = (t) => t.split('\n').filter(Boolean).map((line) => { const out = []; let cell = '', q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cell); cell = ''; } else cell += ch; }
  out.push(cell); return out; });
const userProps = {};
const addon = { console, Utilities: { parseCsv },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({}) },
  PropertiesService: { getUserProperties: () => ({ getProperty: (k) => userProps[k] ?? null, setProperty: (k, v) => { userProps[k] = v; }, deleteProperty: (k) => { delete userProps[k]; } }) },
  UrlFetchApp: { fetch: (url, o) => { const s = box.doPost({ postData: { contents: o.payload } }).s; return { getContentText: () => s, getResponseCode: () => 200 }; } } };
vm.createContext(addon);
vm.runInContext(read('sheets-addon/Code.gs'), addon);
const sheet = (fn, ...a) => { try { return { ok: true, v: addon[fn](...a) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } };

// ---- the phone: sends exactly the fields the Kotlin source sends ----
const SIM_KEYS = simSent, SYNC_KEYS = syncSent;
const phone = {
  pair(code) { const r = post({ action: 'smsPairDevice', code, model: 'Samsung A15', appVersion: '1.0.4', androidVersion: '14' }); this.id = r.deviceId; this.secret = r.deviceSecret; return r; },
  sims: [{ subscriptionId: 3, slotIndex: 0, carrierName: 'Vodafone KI', displayName: 'SIM 1', numberHint: '777', iccHash: 'h1' }],
  results: [], inbound: [], held: [],
  sync(take) {
    const body = { deviceId: this.id, deviceSecret: this.secret, appVersion: '1.0.4', androidVersion: '14', sims: this.sims, results: this.results, inbound: this.inbound, take };
    if (J(Object.keys(body).sort()) !== J(SYNC_KEYS.slice().sort())) throw new Error('simulator out of step with SyncWorker.kt: ' + J(Object.keys(body)));
    this.sims.forEach((s) => { if (J(Object.keys(s).sort()) !== J(SIM_KEYS.slice().sort())) throw new Error('SIM shape out of step with Sims.kt'); });
    const r = post(Object.assign({ action: 'smsDeviceSync' }, body));
    if (r.ok) { this.results = []; this.inbound = []; (r.messages || []).forEach((m) => this.held.push(m)); this.held = this.held.filter((m) => !(r.stop || []).includes(m.messageId)); }
    return r;
  },
  report(m, status, error) { this.results.push({ messageId: m.messageId, status, error: error || '', at: new Date().toISOString(), simKey: m.simKey }); }
};

// 1. The store's contacts arrive from a Google Sheet.
ok('(setup) the store makes an add-on key on Mwakete.com', !!(web('smsApiKeyCreate', { label: 'Office' }).apiKey));
const KEY = rows('SmsApiKeys')[0] && web('smsApiKeyCreate', { label: 'Office 2' }).apiKey;
ok('the Sheet connects with it', sheet('mwkConnect', KEY).ok);
const VIP = web('contactGroupSave', { name: 'VIP' }).group.groupId;
active = sheets.Signup = mkSheet('Signup', [['Name', 'Phone', 'Island'], ['Teraoi', '73011111', 'Tarawa'], ['Bwebwe', '73022222', 'Abaiang'], ['Kanoa', '63033333', 'Tarawa'], ['Ghost', '12', '']]);
let r = sheet('mwkApplyImport', { groupId: VIP, consentPromotional: true, consentSource: 'sign-up sheet at the shop, 2 Nov 2026' });
ok('Sheet -> 3 contacts in the VIP group with a recorded promotions yes (bad number skipped)', r.ok && r.v.added === 3 && r.v.invalid === 1 && rows('Contacts').every((c) => c.ConsentPromotional === 'yes'), J(r));

// 2. The Sheet drafts a campaign to the group.
r = sheet('mwkSaveDraft', { name: 'Fish Friday', kind: 'promotional', body: 'Mauri {first_name|friend}! Fresh tuna on Friday. Reply STOP to opt out.', to: 'group', groupId: VIP });
const campId = r.ok && r.v.campaignId;
ok('Sheet -> a draft campaign (nothing queued yet)', r.ok && rows('SmsCampaigns')[0].Status === 'draft' && rows('SmsMessages').length === 0, J(r));

// 3. Mwakete.com connects a phone.
const code = web('smsPairStart', { name: 'Shop phone' }).code;
r = phone.pair(code);
ok('phone pairs with the code from Mwakete.com', r.ok && r.storeName === 'A Shop' && !!r.settings, J(r));
ok('...and its first check-in reports its SIM', phone.sync(0).ok && web('smsDevices').devices[0].sims.length === 1);
const simKey = web('smsDevices').devices[0].sims[0].simKey;

// 4. Mwakete.com picks the phone + SIM and starts it (the add-on cannot).
ok('the add-on key cannot start it', !sheet('mwkCall_', 'smsCampaignApprove', { campaignId: campId, confirmRecipients: 3 }).ok);
const draft = web('smsCampaignGet', { campaignId: campId }).campaign;
r = web('smsCampaignSave', { campaignId: campId, name: draft.name, kind: draft.kind, body: draft.body, groupIds: draft.groupIds, deviceId: phone.id, simKey });
ok('Mwakete.com sets the phone and SIM on the draft', r.ok && r.campaign.simKey === simKey, J(r));
web('smsSettingsSave', { quietStart: 0, quietEnd: 0 });   // no quiet hours for this run
r = web('smsCampaignApprove', { campaignId: campId, confirmRecipients: 3, requestId: 'journey-1' });
ok('Mwakete.com starts it: 3 personalised messages queued', r.ok && rows('SmsMessages').length === 3 && rows('SmsMessages').every((m) => /^Mauri (Teraoi|Bwebwe|Kanoa)! Fresh tuna/.test(m.Body)), J(r));

// 5. The phone sends.
r = phone.sync(20);
ok('the phone takes all 3, each with the SIM\'s subscription id and the interval', r.ok && phone.held.length === 3 && phone.held.every((m) => String(m.subscriptionId) === '3' && m.intervalSeconds >= 3 && m.to && m.body), J(r.messages));
ok('...every message field the app reads is there', ['messageId', 'to', 'body', 'simKey', 'subscriptionId', 'intervalSeconds'].every((k) => phone.held.every((m) => m[k] !== undefined)));
ok('...and so is every setting it reads', ['quietStart', 'quietEnd', 'utcOffset', 'intervalSeconds', 'batchSize', 'suspended'].every((k) => r.settings[k] !== undefined) && 'stop' in r && 'rotateSecret' in r, J(r.settings));
const [m1, m2, m3] = phone.held;
phone.report(m1, 'submitted'); phone.report(m1, 'sent'); phone.report(m1, 'delivered');
phone.report(m2, 'submitted'); phone.report(m2, 'sent');
phone.report(m3, 'submitted'); phone.report(m3, 'failed', 'no_service');
const kanoaPhone = rows('SmsMessages').find((m) => m.MessageId === m2.messageId).Phone;
phone.inbound.push({ from: kanoaPhone.replace('+686', ''), text: 'Stop', at: new Date().toISOString() });
phone.inbound.push({ from: '73099999', text: 'Is the tuna fresh?', at: new Date().toISOString() });
r = phone.sync(0);
ok('the phone reports delivered / sent / failed (7 reports applied)', r.ok && r.accepted === 7, J(r));
const msg = (id) => rows('SmsMessages').find((m) => m.MessageId === id);
ok('...statuses on Mwakete.com: delivered, sent, failed (no_service)', msg(m1.messageId).Status === 'delivered' && msg(m2.messageId).Status === 'sent' && msg(m3.messageId).Status === 'failed' && msg(m3.messageId).Error === 'no_service');
ok('a "Stop" reply opts that person out of promotions, from the store\'s side', rows('SmsSuppression').some((s) => s.Phone === kanoaPhone) &&
  rows('Contacts').find((c) => c.Phone === kanoaPhone).ConsentPromotional === 'no', J(rows('SmsSuppression')));
ok('...an ordinary reply is not stored anywhere', !J(box.__sheets).includes('Is the tuna fresh'));

// 6. The store retries the failure; the phone sends it.
r = web('smsCampaignRetry', { campaignId: campId });
ok('Mwakete.com retries the failed one', r.ok && r.requeued === 1, J(r));
r = phone.sync(20);
const again = phone.held.filter((m) => m.messageId === m3.messageId);
ok('...the phone gets it again', again.length === 2, J(r.messages));
phone.report(m3, 'sent');
phone.sync(0);
ok('...and it is sent; the campaign is complete', msg(m3.messageId).Status === 'sent' && web('smsCampaignGet', { campaignId: campId }).campaign.status === 'completed');

// 7. Next campaign: the person who said STOP is left out automatically.
r = sheet('mwkEstimate', { name: 'x', kind: 'promotional', body: 'More tuna!', to: 'group', groupId: VIP });
ok('the next promotion from the Sheet leaves out the person who replied STOP', r.ok && r.v.recipients === 2 && r.v.skipped.opted_out === 1, J(r));

// 8. The Sheet pulls the results.
r = sheet('mwkCampaignResults', campId);
const res = r.ok && sheets[r.v.sheetName];
const statusCol = res && res.grid[0].indexOf('Status');
ok('the Sheet gets the results: 1 delivered, 2 accepted by network (incl. the retried one)', r.ok && r.v.count === 3 && res.grid.slice(1).map((x) => x[statusCol]).sort().join('|') === 'Accepted by network|Accepted by network|Delivered', J(res && res.grid));
ok('usage on Mwakete.com counts the SMS the phone reported', web('smsUsage', {}).ok);

// 9. Isolation and the phone being removed.
ok('another store sees none of it', post({ action: 'contactsList', token: 'tok-b' }).contacts.length === 0 && post({ action: 'smsCampaigns', token: 'tok-b' }).campaigns.length === 0);
web('smsDeviceRevoke', { deviceId: phone.id });
r = phone.sync(0);
ok('a phone removed on Mwakete.com is refused with device_revoked (the app then forgets the store)', !r.ok && r.errorKind === 'device_revoked', J(r));

console.log(`\n${pass}/${pass + fails} passed`);
process.exit(fails ? 1 : 0);
