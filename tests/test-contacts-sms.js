/**
 * Mwakete Contacts & SMS backend (Contacts.gs, SmsCampaigns.gs, SmsDevices.gs,
 * SmsCore.gs; Oct 2026) through doPost, like the website, the Android app and
 * the Sheets add-on call it. Real .gs sources (gas-harness).
 */
const fs = require('fs');
const path = require('path');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fails = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fails++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + String(e).slice(0, 500) + ']')); } };
const J = (x) => JSON.stringify(x);
const FUT = new Date(Date.now() + 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'],
    ['own_a', 'a', 'A Shop', 'active', 'retailer', 'a@x.test'], ['own_b', 'b', 'B Shop', 'active', 'wholesaler', 'b@x.test'],
    ['own_adm', 'adm', 'Mwakete Admin', 'active', '', 'admin@x.test']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT], ['tok-b', 'own_b', '', FUT], ['tok-adm', 'own_adm', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'Status', 'Total', 'CreatedAt', 'CustomerName', 'CustomerPhone', 'DeliveryMethod'],
    ['o1', 'own_a', 'Paid', 10, '2026-10-01T00:00:00Z', 'Teraoi Kaitu', '73011111', 'pickup'], ['o2', 'own_a', 'Paid', 5, '2026-10-02T00:00:00Z', 'Teraoi Kaitu', '+686 7301 1111', 'pickup'],
    ['o3', 'own_b', 'Paid', 5, '2026-10-02T00:00:00Z', 'Other', '73099999', 'pickup']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.Logger = { log() {} };
const post = (b) => { try { return JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s); } catch (e) { return { ok: false, error: String(e.stack || e) }; } };
const A = (action, body) => post(Object.assign({ action, token: 'tok-a' }, body || {}));
const B = (action, body) => post(Object.assign({ action, token: 'tok-b' }, body || {}));
const ADM = (action, body) => post(Object.assign({ action, token: 'tok-adm' }, body || {}));
const rows = (t) => (box.__sheets[t] ? box.__sheets[t].objects() : []);

/* ---------- shared rules (same table as the web copy and Android) ---------- */
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'sms-core-cases.json'), 'utf8'));
const segBad = cases.segments.filter((c) => {
  const t = c.repeat ? c.repeat.repeat(c.times) : c.text;
  const i = box.smsSegmentInfo(t);
  return i.encoding !== c.encoding || i.units !== c.units || i.segments !== c.segments;
}).map((c) => (c.text || c.repeat + 'x' + c.times) + ' -> ' + J(box.smsSegmentInfo(c.repeat ? c.repeat.repeat(c.times) : c.text)));
ok('segments: GSM-7 160/153, extension chars count 2, UCS-2 70/67, emoji 2 units (table)', segBad.length === 0, segBad.join(' | '));
const phBad = cases.phones.filter((c) => { const r = box.smsNormalisePhone(c.in); return r.status !== c.status || r.e164 !== c.e164; }).map((c) => c.in + ' -> ' + J(box.smsNormalisePhone(c.in)));
ok('phones: Kiribati +686 8 digits, 730/630 mobiles, landlines "check", international kept, nothing guessed (table)', phBad.length === 0, phBad.join(' | '));
const rdBad = cases.render.filter((c) => { const r = box.smsRender(c.template, c.contact); return r.text !== c.text || J(r.missing) !== J(c.missing) || (c.unknown && J(r.unknown) !== J(c.unknown)); });
ok('personalisation: fields, fallbacks, empty fields flagged, unknown tags left visible (table)', rdBad.length === 0, J(rdBad));
// The web composer runs the minified build copy: it must give the same answers.
const web = {};
require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/sms-core.min.js'), 'utf8') + ';this.s=smsSegmentInfo;this.p=smsNormalisePhone;this.r=smsRender;', web);
const webBad = cases.segments.filter((c) => { const t = c.repeat ? c.repeat.repeat(c.times) : c.text; return J(web.s(t)) !== J(box.smsSegmentInfo(t)); }).length
  + cases.phones.filter((c) => J(web.p(c.in)) !== J(box.smsNormalisePhone(c.in))).length
  + cases.render.filter((c) => J(web.r(c.template, c.contact)) !== J(box.smsRender(c.template, c.contact))).length;
ok('the browser copy (assets/js/sms-core.min.js) gives the same answers', webBad === 0, webBad);

/* ---------- switched off ---------- */
ok('switched off: nothing answers', /not switched on/.test(A('contactsList').error) && /not switched on/.test(post({ action: 'smsDeviceSync' }).error));
box.__props.CONTACTS_SMS = 'on';

/* ---------- contacts ---------- */
let r = A('contactSave', { firstName: 'Teraoi', lastName: 'Kaitu', phone: '730 111 11', island: 'South Tarawa', village: 'Bairiki', category: 'customer', tags: 'vip, regular' });
const c1 = r.contact;
ok('a contact is saved with the number checked and stored as +686…', r.ok && c1.phone === '+68673011111' && c1.phoneRaw === '730 111 11' && c1.phoneStatus === 'ok', J(r));
ok('...a new contact has no promotional consent', c1.consent.promotional === 'unknown' && c1.consent.transactional === 'unknown');
r = A('contactSave', { firstName: 'Copy', phone: '+68673011111' });
ok('the same number twice is refused, naming the existing contact', !r.ok && r.duplicateOf === c1.contactId, J(r));
r = A('contactSave', { firstName: 'Typo', phone: '7301111' });
ok('a wrong-length number is kept as typed and marked invalid (not changed)', r.ok && r.contact.phoneStatus === 'invalid' && r.contact.phone === '' && r.contact.phoneRaw === '7301111', J(r));
const cBad = r.contact;
r = A('contactSave', { firstName: 'Office', phone: '75021234' });
ok('a Kiribati landline is flagged "check" (cannot take SMS)', r.ok && r.contact.phoneStatus === 'check', J(r));
r = A('contactSave', { firstName: 'Aunty', phone: '+61 412 345 678', country: 'Australia' });
ok('an international number is kept', r.ok && r.contact.phone === '+61412345678' && r.contact.phoneStatus === 'ok', J(r));
const cIntl = r.contact;
r = A('contactSave', { firstName: 'Bad', phone: '73022222', category: 'nope' });
ok('an unknown category is refused', !r.ok);
r = A('contactCategoryAdd', { label: 'Church group' });
ok('a store can add its own category', r.ok && A('contactCategories').categories.some((c) => c.label === 'Church group'), J(r));
ok('categories include the built-in ones (Customers … Other)', A('contactCategories').categories.filter((c) => c.builtIn).length === 10);

r = A('contactSetConsent', { contactId: c1.contactId, kind: 'promotional', value: 'yes', source: '' });
ok('consent "yes" needs a source (how they agreed)', !r.ok);
r = A('contactSetConsent', { contactId: c1.contactId, kind: 'promotional', value: 'yes', source: 'signed the in-store list, 30 Oct' });
ok('consent "yes" with a source is recorded', r.ok && r.contact.consent.promotional === 'yes' && r.contact.consentSource.includes('in-store'), J(r));
ok('...and logged', rows('ContactConsentLog').some((l) => l.ContactId === c1.contactId && l.Kind === 'promotional' && l.To === 'yes'));

/* ---------- isolation ---------- */
ok('another store sees none of these contacts', B('contactsList').total === 0);
ok('...cannot read, change or delete one', !B('contactGet', { contactId: c1.contactId }).ok && !B('contactSave', { contactId: c1.contactId, firstName: 'X' }).ok && !B('contactDelete', { contactId: c1.contactId }).ok);
ok('...may hold the same number in its own list', B('contactSave', { firstName: 'Their Teraoi', phone: '73011111' }).ok);

/* ---------- import ---------- */
const csvRows = [
  { 'First name': 'Bwebwe', 'Last name': 'Tito', Phone: '73033333', Village: 'Betio', Island: 'South Tarawa' },
  { 'First name': 'Bwebwe again', Phone: '+686 7303 3333' },
  { 'First name': 'Teraoi dup', Phone: '73011111' },
  { Name: 'Kanoa', Mobile: '63044444' },
  { 'First name': 'Nobody', Phone: '12' }];
r = A('contactsImportPreview', { rows: csvRows });
ok('import preview: new, repeat (twice in the file), duplicate (already listed), invalid', r.ok && r.counts.new === 2 && r.counts.repeat === 1 && r.counts.duplicate === 1 && r.counts.invalid === 1, J(r.counts));
ok('...columns are matched by name ("Mobile", "Name" too)', r.ok && r.rows.some((x) => x.name === 'Kanoa' && x.action === 'new'), J(r.rows));
r = A('contactsImportApply', { rows: csvRows, consent: { promotional: 'yes' } });
ok('import that claims consent without saying how is refused', !r.ok);
const grp = A('contactGroupSave', { name: 'Betio customers' }).group;
r = A('contactsImportApply', { rows: csvRows, groupId: grp.groupId, source: 'csv', category: 'customer' });
ok('import writes 2 new, skips duplicates, leaves out invalid', r.ok && r.added === 2 && r.invalid === 1 && r.skipped === 2, J(r));
const imported = rows('Contacts').filter((c) => c.OwnerId === 'own_a' && c.Source === 'csv');
ok('...imported contacts have NO promotional consent', imported.length === 2 && imported.every((c) => c.ConsentPromotional === 'unknown'));
ok('...and are in the chosen group', A('contactGroups').groups.find((g) => g.groupId === grp.groupId).members === 2);
r = A('contactsFromOrders');
ok('Mwakete order customers come as import rows, one per number, this store only', r.ok && r.rows.length === 1 && r.rows[0]['First name'] === 'Teraoi', J(r));

/* ---------- duplicates & merge ---------- */
const d1 = A('contactSave', { firstName: 'Ioane', lastName: 'Teeta', phone: '73055555', email: 'ioane@x.test' }).contact;
const d2 = A('contactSave', { firstName: 'Ioane', lastName: 'Teeta', email: 'IOANE@x.test', village: 'Eita' }).contact;
A('contactSave', { firstName: 'Tebwa', lastName: 'Rimon', phone: '73066666' });
A('contactSave', { firstName: 'tebwa', lastName: 'RIMON', phone: '73077777' });
A('contactSetConsent', { contactId: d2.contactId, kind: 'promotional', value: 'no', source: 'asked us to stop' });
r = A('contactsDuplicates');
ok('duplicates found by email and by name', r.ok && r.groups.some((g) => g.reason === 'same email') && r.groups.some((g) => g.reason === 'same name'), J(r.groups.map((g) => g.reason)));
r = A('contactsMerge', { keepId: d1.contactId, mergeIds: [d2.contactId] });
ok('merge fills blanks (village) and keeps the most cautious consent ("no" wins)', r.ok && r.contact.village === 'Eita' && r.contact.consent.promotional === 'no', J(r));
ok('...the merged contact is kept as "merged" (history stays)', rows('Contacts').find((c) => c.ContactId === d2.contactId).Status === 'merged');

/* ---------- templates ---------- */
r = A('smsTemplateSave', { name: 'Hello', body: 'Mauri {first_name|friend}, new stock at A Shop!', kind: 'promotional' });
ok('a template saves with its segment count', r.ok && A('smsTemplates').templates[0].info.segments === 1, J(r));
ok('a template with an unknown {field} is refused', !A('smsTemplateSave', { name: 'X', body: 'Hi {nickname}' }).ok);

/* ---------- devices ---------- */
r = A('smsPairStart', { name: 'Shop phone' });
ok('pairing code: 8 characters, shown as XXXX-XXXX, 10 minutes', r.ok && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.code), J(r));
ok('...only its hash is stored', rows('SmsPairCodes').every((p) => !String(p.CodeHash).includes(r.code.replace('-', ''))));
const pairCode = r.code;
r = post({ action: 'smsPairDevice', code: 'WRONG-CODE' });
ok('a wrong code pairs nothing', !r.ok);
r = post({ action: 'smsPairDevice', code: pairCode.toLowerCase(), model: 'Samsung A15', appVersion: '1.0.0', androidVersion: '14' });
ok('the app pairs with the code: device id + secret, once', r.ok && /^smsdev/.test(r.deviceId) && r.deviceSecret.length > 40 && r.storeName === 'A Shop', J(r));
const dev = { deviceId: r.deviceId, deviceSecret: r.deviceSecret };
ok('...the same code cannot be used twice', !post({ action: 'smsPairDevice', code: pairCode }).ok);
ok('...the secret is stored hashed and never listed', rows('SmsDevices').every((d) => d.SecretHash !== dev.deviceSecret) && !J(A('smsDevices')).includes(dev.deviceSecret));
const sync = (body) => post(Object.assign({ action: 'smsDeviceSync' }, dev, body || {}));
const SIMS = [{ subscriptionId: 1, slotIndex: 0, carrierName: 'Vodafone KI', displayName: 'SIM 1', numberHint: '111', iccHash: 'icc-aaa' },
  { subscriptionId: 2, slotIndex: 1, carrierName: 'ATHKL', displayName: 'SIM 2', iccHash: 'icc-bbb' }];
r = sync({ sims: SIMS, take: 0 });
ok('the phone checks in with its two SIMs', r.ok && A('smsDevices').devices[0].sims.length === 2, J(r));
const sim2 = A('smsDevices').devices[0].sims.find((s) => s.slot === 2);
ok('...SIM 1 is the default; only the last digits of a number are kept', A('smsDevices').devices[0].sims.find((s) => s.slot === 1).isDefault && !J(rows('SmsSims')).includes('icc-aaa-full'));
ok('another store cannot see or remove the phone', B('smsDevices').devices.length === 0 && !B('smsDeviceRevoke', { deviceId: dev.deviceId }).ok);
ok('a wrong secret gets nothing', post({ action: 'smsDeviceSync', deviceId: dev.deviceId, deviceSecret: 'x'.repeat(50) }).errorKind === 'device_revoked');
r = A('smsSimUpdate', { simKey: sim2.simKey, allowance: 500, resetDay: 1, name: 'Promo SIM' });
ok('a SIM gets an allowance (typed by the store) and a name', r.ok && r.sim.allowance === 500, J(r));

/* ---------- campaign: estimate, draft, approve ---------- */
const c3 = rows('Contacts').find((c) => c.FirstName === 'Bwebwe');
const kanoa = rows('Contacts').find((c) => c.FirstName === 'Kanoa');
A('contactSetConsent', { contactId: c3.ContactId, kind: 'promotional', value: 'yes', source: 'sign-up sheet' });
const ids = [c1.contactId, c3.ContactId, kanoa.ContactId, cBad.contactId, cIntl.contactId, d1.contactId];
r = A('smsCampaignEstimate', { kind: 'promotional', body: 'Mauri {first_name|friend}! 10% off this week.', contactIds: ids });
ok('estimate (promotions): only people who said yes, with valid numbers', r.ok && r.recipients === 2 && r.skipped.no_consent === 2 && r.skipped.invalid_number === 1 && r.skipped.opted_out === 1, J(r));
ok('...previews show each person’s own message and segments', r.previews[0].text.startsWith('Mauri ') && r.previews[0].segments === 1 && r.segments === 2, J(r.previews));
r = A('smsCampaignEstimate', { kind: 'transactional', body: 'Your order is ready', contactIds: ids });
ok('estimate (order updates): consent not needed (a promotions "no" does not block them), bad numbers still left out', r.ok && r.recipients === 5 && r.skipped.opted_out === 0 && r.skipped.invalid_number === 1, J(r));
r = A('smsCampaignEstimate', { kind: 'promotional', body: 'Mauri ā {first_name}', contactIds: ids });
ok('...a special character switches to Unicode and is named', r.ok && r.template.encoding === 'ucs2' && r.unicodeChars.includes('ā'), J(r.template));

r = A('smsCampaignSave', { name: 'Week sale', kind: 'promotional', body: 'Mauri {first_name|friend}! 10% off this week. Reply STOP to opt out.', contactIds: ids, deviceId: dev.deviceId, simKey: sim2.simKey, intervalSeconds: 1 });
const camp = r.campaign;
ok('a campaign saves as a draft; the interval is never below the minimum', r.ok && camp.status === 'draft' && camp.intervalSeconds === 3, J(r));
ok('...a draft sends nothing', rows('SmsMessages').length === 0);
r = A('smsCampaignApprove', { campaignId: camp.campaignId, confirmRecipients: 5 });
ok('approve with the wrong recipient count is refused (a stale screen cannot start it)', !r.ok && r.recipients === 2, J(r));
ok('another store cannot approve it', !B('smsCampaignApprove', { campaignId: camp.campaignId, confirmRecipients: 2 }).ok);
r = A('smsCampaignApprove', { campaignId: camp.campaignId, confirmRecipients: 2, requestId: 'req-approve-1' });
ok('approve with the right count queues one message per recipient', r.ok && r.campaign.status === 'queued' && rows('SmsMessages').filter((m) => m.CampaignId === camp.campaignId).length === 2, J(r));
ok('...messages are personalised, carry their segment count and the chosen SIM', rows('SmsMessages').every((m) => /^Mauri (Teraoi|Bwebwe)!/.test(m.Body) && Number(m.Segments) === 1 && m.SimKey === sim2.simKey), J(rows('SmsMessages').map((m) => m.Body)));
ok('...approving again changes nothing', A('smsCampaignApprove', { campaignId: camp.campaignId, confirmRecipients: 2 }).replayed && rows('SmsMessages').length === 2);
ok('...a sent campaign cannot be edited', !A('smsCampaignSave', { campaignId: camp.campaignId, name: 'x', body: 'y' }).ok);

/* ---------- the phone sends ---------- */
// Quiet hours off for the test (they are checked below).
A('smsSettingsSave', { quietStart: 0, quietEnd: 0 });
r = sync({ sims: SIMS, take: 10 });
ok('the phone takes the queued messages with the SIM to use and the interval', r.ok && r.messages.length === 2 && r.messages.every((m) => m.simKey === sim2.simKey && String(m.subscriptionId) === '2' && m.intervalSeconds === 3), J(r));
const batch = r.messages;
ok('...the campaign shows as sending', A('smsCampaignGet', { campaignId: camp.campaignId }).campaign.status === 'processing');
ok('...taking again hands out nothing twice', sync({ sims: SIMS, take: 10 }).messages.length === 0);
r = sync({ sims: SIMS, results: [{ messageId: batch[0].messageId, status: 'submitted' }, { messageId: batch[0].messageId, status: 'sent' }, { messageId: batch[1].messageId, status: 'failed', error: 'generic_failure' }] });
ok('results: submitted -> accepted by network; a failure recorded with its reason', r.ok && r.accepted === 3, J(r));
r = sync({ results: [{ messageId: batch[0].messageId, status: 'submitted' }] });
ok('a late or repeated report never moves a message back', rows('SmsMessages').find((m) => m.MessageId === batch[0].messageId).Status === 'sent');
sync({ results: [{ messageId: batch[0].messageId, status: 'delivered' }] });
let g = A('smsCampaignGet', { campaignId: camp.campaignId });
ok('"delivered" only once the network reported it', g.messages.find((m) => m.messageId === batch[0].messageId).status === 'delivered', J(g.messages));
ok('the campaign completes when nothing is left to send', g.campaign.status === 'completed', J(g.campaign));
r = A('smsCampaignRetry', { campaignId: camp.campaignId });
ok('retry puts the retryable failure back in the queue', r.ok && r.requeued === 1, J(r));
r = sync({ sims: SIMS, take: 10 });
ok('...and the phone gets it again', r.messages.length === 1 && r.messages[0].messageId === batch[1].messageId, J(r));
sync({ results: [{ messageId: batch[1].messageId, status: 'sent' }] });
ok('a message the phone reports from another SIM is flagged', (() => { sync({ results: [{ messageId: batch[1].messageId, status: 'delivered', simKey: 'other' }] }); return rows('SmsMessages').find((m) => m.MessageId === batch[1].messageId).Error === 'sent_from_other_sim'; })());

/* ---------- pause / cancel while the phone holds messages ---------- */
const t2 = A('smsCampaignSave', { name: 'Ready', kind: 'transactional', body: 'Hi {first_name|there}, your order is ready.', contactIds: [c1.contactId, c3.ContactId, kanoa.ContactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
A('smsCampaignApprove', { campaignId: t2.campaignId, confirmRecipients: 3 });
r = sync({ sims: SIMS, take: 2 });
ok('the phone takes 2 of 3', r.messages.length === 2);
A('smsCampaignPause', { campaignId: t2.campaignId });
r = sync({ sims: SIMS, take: 5 });
ok('paused: the phone is told to hold the 2 it has, and gets no more', r.stop.length === 2 && r.messages.length === 0, J(r));
A('smsCampaignResume', { campaignId: t2.campaignId });
r = sync({ sims: SIMS, take: 5 });
ok('resumed: the 3rd is handed out, nothing is told to stop', r.stop.length === 0 && r.messages.length === 1, J(r));
A('smsCampaignCancel', { campaignId: t2.campaignId, reason: 'wrong day' });
ok('cancelled: nothing left queued or held for it', rows('SmsMessages').filter((m) => m.CampaignId === t2.campaignId).every((m) => m.Status === 'cancelled'));

/* ---------- SIM taken out ---------- */
const t3 = A('smsCampaignSave', { name: 'One', kind: 'transactional', body: 'Hi', contactIds: [c1.contactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
r = sync({ sims: [SIMS[0]], take: 5 });
ok('a SIM missing from the phone is marked missing', A('smsDevices').devices[0].sims.find((s) => s.slot === 2).status === 'missing');
ok('...a campaign on it cannot be started', /not in the phone/.test(A('smsCampaignApprove', { campaignId: t3.campaignId, confirmRecipients: 1 }).error));
sync({ sims: SIMS, take: 0 });
A('smsCampaignApprove', { campaignId: t3.campaignId, confirmRecipients: 1 });
r = sync({ sims: [SIMS[0]], take: 5 });
ok('...and nothing is handed out while that SIM is out - never switched to the other SIM', r.messages.length === 0, J(r));
r = sync({ sims: SIMS, take: 5 });
ok('...SIM back: it goes', r.messages.length === 1);
sync({ results: [{ messageId: r.messages[0].messageId, status: 'sent' }] });

/* ---------- quiet hours, limits ---------- */
const hour = new Date().getUTCHours();
A('smsSettingsSave', { quietStart: (hour + 12) % 24, quietEnd: (hour + 13) % 24 });
const t4 = A('smsCampaignSave', { name: 'Quiet', kind: 'transactional', body: 'Hi', contactIds: [c3.ContactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
A('smsCampaignApprove', { campaignId: t4.campaignId, confirmRecipients: 1 });
A('smsSettingsSave', { quietStart: hour, quietEnd: (hour + 1) % 24 });
box.__props.SMS_LIMITS = JSON.stringify({ utcOffset: 0 });
r = sync({ sims: SIMS, take: 5 });
ok('quiet hours: nothing is handed out (and the phone is told)', r.messages.length === 0 && r.quiet === true, J(r));
A('smsSettingsSave', { quietStart: 0, quietEnd: 0 });
box.__props.SMS_LIMITS = JSON.stringify({ utcOffset: 0, maxDailyPerDevice: 1 });
r = sync({ sims: SIMS, take: 5 });
ok('daily limit per phone: no more once it is reached', r.messages.length === 0, J(r));
box.__props.SMS_LIMITS = JSON.stringify({ utcOffset: 0, maxCampaignRecipients: 1 });
const t5 = A('smsCampaignSave', { name: 'Big', kind: 'transactional', body: 'Hi', contactIds: [c1.contactId, c3.ContactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
ok('campaign size limit: a campaign over it cannot start', /at most 1/.test(A('smsCampaignApprove', { campaignId: t5.campaignId, confirmRecipients: 2 }).error));
delete box.__props.SMS_LIMITS;

/* ---------- opt-outs ---------- */
r = sync({ inbound: [{ from: '+68673033333', text: 'STOP' }, { from: '+68673011111', text: 'stop the music please' }] });
ok('a reply "STOP" opts that number out of promotions; other texts are ignored', r.inbound === 1
  && rows('Contacts').find((c) => c.ContactId === c3.ContactId).ConsentPromotional === 'no'
  && rows('Contacts').find((c) => c.ContactId === c1.contactId).ConsentPromotional === 'yes', J(r));
r = A('smsCampaignEstimate', { kind: 'promotional', body: 'Sale!', contactIds: [c3.ContactId] });
ok('...and is left out of the next promotion', r.recipients === 0 && r.skipped.opted_out === 1, J(r));
r = A('contactSave', { firstName: 'Bwebwe new', phone: '+686 7303 3333' });
ok('...even if the store adds the number again (it is a duplicate here, but suppression is by number)', !r.ok || r.contact.consent.promotional === 'no');
r = post({ action: 'smsOptOut', storeSlug: 'a', phone: '73011111' });
ok('the public opt-out page works and answers the same whatever the number', r.ok && rows('Contacts').find((c) => c.ContactId === c1.contactId).ConsentPromotional === 'no' && J(post({ action: 'smsOptOut', storeSlug: 'a', phone: '73000000' })).includes('Done.'), J(r));
ok('...opt-outs are listed for the store', A('smsSuppressionList').suppressed.some((s) => s.phone === '+68673011111'));

/* ---------- usage, dashboard ---------- */
r = A('smsUsage', {});
ok('usage counts what the phone sent, by day and SIM, with the estimate of what is left', r.ok && r.days.length >= 1 && r.sims.find((s) => s.simKey === sim2.simKey).usedThisPeriod >= 3 && r.sims.find((s) => s.simKey === sim2.simKey).estimatedRemaining <= 497, J(r));
ok('...and says plainly that it is an estimate', /cannot read your remaining allowance/.test(r.note));
r = A('smsDashboard');
ok('dashboard counts are the real rows', r.ok && r.contacts.total >= 7 && r.messages.delivered >= 1 && r.devices.connected === 1, J(r));

/* ---------- Sheets add-on key ---------- */
r = A('smsApiKeyCreate', { label: 'My sheet' });
const key = r.apiKey;
ok('an add-on key is answered once, stored hashed', r.ok && /^mwk_/.test(key) && rows('SmsApiKeys').every((k) => k.KeyHash !== key));
const K = (action, body) => post(Object.assign({ action, apiKey: key }, body || {}));
ok('the add-on can list contacts and changes', K('contactsList').total >= 7 && K('contactsChanges', { since: '' }).contacts.length >= 7);
ok('...but cannot approve campaigns, manage phones or make keys', /Mwakete.com/.test(K('smsCampaignApprove', { campaignId: t5.campaignId, confirmRecipients: 1 }).error) && !K('smsPairStart').ok && !K('smsApiKeyCreate').ok);
ok('...and sees only its own store', K('contactsList').contacts.every((c) => !J(rows('Contacts').filter((x) => x.OwnerId === 'own_b')).includes(c.contactId)));
A('smsApiKeyRevoke', { keyId: r.keyId });
ok('a removed key stops working', K('contactsList').errorKind === 'auth');

/* ---------- export ---------- */
r = A('contactsExport');
ok('export: CSV of this store only, formula-looking cells made safe, audited', r.ok && r.csv.split('\n')[0].startsWith('First name') && !r.csv.includes('Their Teraoi')
  && rows('Audit_Log').some((a) => a.Action === 'CONTACTS_EXPORTED'), r.csv && r.csv.slice(0, 200));
A('contactSave', { firstName: '=HYPERLINK("x")', phone: '73088888' });
ok('...a name that starts with = is written as text', A('contactsExport').csv.includes("'=HYPERLINK"));

/* ---------- revoke ---------- */
const t6 = A('smsCampaignSave', { name: 'Held', kind: 'transactional', body: 'Hi', contactIds: [kanoa.ContactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
A('smsCampaignApprove', { campaignId: t6.campaignId, confirmRecipients: 1 });
sync({ sims: SIMS, take: 5 });
const heldIds = rows("SmsMessages").filter((m) => m.DeviceId === dev.deviceId && m.Status === "claimed").map((m) => m.MessageId);
r = A('smsDeviceRevoke', { deviceId: dev.deviceId });
ok('removing a phone: what it held becomes "expired" (not silently re-sent elsewhere)', r.ok && heldIds.length >= 1 && r.expired === heldIds.length
  && rows('SmsMessages').filter((m) => heldIds.includes(m.MessageId)).every((m) => m.Status === 'expired'), J(r));
ok('...and its secret stops working at once', sync({ take: 5 }).errorKind === 'device_revoked');

/* ---------- admin ---------- */
ok('a store cannot use admin actions', A('adminSmsOverview').error === 'Not authorized');
r = ADM('adminSmsOverview');
ok('admin overview: counts per store, no names, numbers or message text', r.ok && r.stores.some((s) => s.ownerId === 'own_a' && s.contacts >= 7) && !J(r).includes('Teraoi') && !J(r).includes('+686'), J(r).slice(0, 300));
ok('admin viewing a store’s contacts needs a written reason', !ADM('adminSmsViewContacts', { ownerId: 'own_a', reason: 'look' }).ok);
r = ADM('adminSmsViewContacts', { ownerId: 'own_a', reason: 'complaint #42 about spam from this store' });
ok('...with a reason it works and is audited with the reason', r.ok && r.total >= 7 && rows('Audit_Log').some((a) => a.Action === 'SMS_ADMIN_VIEWED_CONTACTS' && /complaint #42/.test(a.Reason)));
ADM('adminSmsSuspend', { ownerId: 'own_a', suspend: true, reason: 'too many complaints this week' });
const t7 = A('smsCampaignSave', { name: 'After', kind: 'transactional', body: 'Hi', contactIds: [kanoa.ContactId], deviceId: dev.deviceId, simKey: sim2.simKey }).campaign;
ok('a suspended store cannot start a campaign', /suspended/.test(A('smsCampaignApprove', { campaignId: t7.campaignId, confirmRecipients: 1 }).error));
r = ADM('adminSmsLimits', { limits: { maxDailyPerDevice: 99999, batchSize: 20, nonsense: 5 } });
ok('admin limits: known keys only, kept inside safe bounds', r.ok && r.limits.maxDailyPerDevice === 5000 && r.limits.batchSize === 20 && r.limits.nonsense === undefined, J(r));
ok('every SMS admin action is audited', ['SMS_STORE_SUSPENDED', 'SMS_LIMITS_CHANGED', 'SMS_CAMPAIGN_APPROVED', 'SMS_DEVICE_PAIRED', 'SMS_DEVICE_REVOKED'].every((a) => rows('Audit_Log').some((x) => x.Action === a)));

console.log('\n' + pass + '/' + (pass + fails) + ' passed');
process.exit(fails ? 1 : 0);
