/**
 * Drive with Mwakete onboarding (DriverOnboarding.gs, owner request Oct 2026)
 * on the REAL backend sources: Messenger + email, one ID (KPF, National ID or
 * passport) with a photo, the face-check selfie and result, the signed driver
 * agreement (digital or paper), private storage, admin-only viewing, and the
 * 90-day deletion after a driver is rejected or suspended.
 */
const { makeBox, driverDocs, testPngBase64 } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 9e8).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'StoreType'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'retailer'],
    ['own_a', 'mwakete-admin', 'Admin', 'admin@x.test', '', 'active', 'South Tarawa', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    ['cus_d', 'Dan Driver', 'd@x.test', '73000009', 'true', '', ''], ['cus_e', 'Eve Driver', 'e@x.test', '73000008', 'true', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-d', 'cus_d', '', FUT], ['c-e', 'cus_e', '', FUT]]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.__props.DELIVERY_JOBS = 'on';
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const apply = (tok, extra) => { clear(); return box.actionDriverApply(Object.assign(driverDocs(), { token: tok, name: 'Dan Driver', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa' }, extra || {})); };
const [S, A] = box.__sheets.Owners.objects();
const drivers = () => box.__sheets.Drivers.objects();
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

/* ---------- what is required ---------- */
const refuse = (label, extra, re) => { const r = apply('c-d', extra); ok(label, !r.ok && re.test(r.error || ''), J(r)); };
refuse('Messenger is required', { messenger: '' }, /Messenger/);
refuse('a valid email is required', { email: 'not-an-email' }, /email/i);
refuse('one of KPF ID, National ID or passport', { idType: 'driving-licence' }, /KPF ID, National ID or passport/);
refuse('the ID number is required and checked', { idNumber: '##' }, /number on your National ID/);
refuse('a photo of the ID is required', { idPhotoBase64: '' }, /photo of your ID/);
refuse('...and it must be a photo, not a PDF', { idPhotoBase64: pdf }, /photo of your ID/i);
refuse('the face-check photo is required', { selfieBase64: '' }, /face photo/);
refuse('the agreement must be the current version', { contract: Object.assign(driverDocs().contract, { version: 'old' }) }, /updated/);
refuse('digital signing needs the full name typed', { contract: Object.assign(driverDocs().contract, { signedName: 'D' }) }, /full name/);
refuse('...and a drawn signature', { contract: Object.assign(driverDocs().contract, { signatureBase64: '' }) }, /signature/);
refuse('...and the agreement ticked', { contract: Object.assign(driverDocs().contract, { agree: false }) }, /agree/);
refuse('paper signing needs photos of the signed pages', { contract: { version: '2026-10-v1', method: 'paper' === 'x' ? '' : 'physical', pagesBase64: [] } }, /signed pages/);
ok('nothing was saved by any refused application', !box.__sheets.Drivers || drivers().length === 0 && Object.keys(box.__drive.files).length === 0);

/* ---------- a good application ---------- */
let r = apply('c-d', { messenger: 'https://www.facebook.com/dan.driver', email: 'Dan@Mail.test' });
ok('a complete application is accepted, pending review', r.ok && r.status === 'pending', J(r));
const dan = drivers()[0];
ok('Messenger is stored as an m.me link', dan.Messenger === 'https://m.me/dan.driver', dan.Messenger);
ok('email stored normalised', dan.Email === 'dan@mail.test', dan.Email);
ok('ID type and number stored', dan.IdType === 'national' && dan.IdNumber === 'N1234567');
ok('face result and agreement recorded', dan.FaceResult === 'passed' && dan.ContractMethod === 'digital' && dan.ContractSignedName === 'Dan Driver' && dan.ContractVersion === '2026-10-v1' && !!dan.ContractSignedAt);
const files = box.__drive.files;
const danFiles = [dan.IdFileId, dan.SelfieFileId].concat(dan.ContractFileIds.split(','));
ok('ID, selfie and signature saved as files, in one private folder', danFiles.every((id) => files[id] && !files[id].sharing) &&
  new Set(danFiles.map((id) => files[id].folder)).size === 1 && box.__drive.folders[files[dan.IdFileId].folder] === 'Mwakete Driver Documents (private)', J(danFiles));
ok('the sheet holds file ids, never the image data', !JSON.stringify(dan).includes(testPngBase64().slice(0, 40)));
const adminMail = box.__mail.find((m) => /New driver application/.test(m[1]));
ok('admins are emailed the ID type, face result, agreement and Messenger link', adminMail && /National ID/.test(adminMail[2]) && /Face matched/.test(adminMail[2]) && /m\.me\/dan\.driver/.test(adminMail[2]), adminMail && adminMail[2]);

r = apply('c-e', { name: 'Eve Driver', phone: '73000008', messenger: 'eve.drv', idType: 'passport', idNumber: 'KR0001234', faceResult: 'not_matched', faceScore: 0.71,
  contract: { version: '2026-10-v1', method: 'physical', pagesBase64: [testPngBase64(), pdf] } });
ok('paper signing with photos (or a PDF) of the pages is accepted', r.ok, J(r));
const eve = drivers().find((d) => d.Name === 'Eve Driver');
ok('...two page files kept, face "not matched" flagged for a person to check', eve.ContractMethod === 'physical' && eve.ContractFileIds.split(',').length === 2 && eve.FaceResult === 'not_matched');

/* ---------- admin ---------- */
const list = box.actionAdminListDeliveries(A, {});
const dv = list.drivers.find((d) => d.name === 'Eve Driver');
ok('the admin list shows the document summary', dv.docs.idType === 'Passport' && dv.docs.idNumber === 'KR0001234' && /did not match/.test(dv.docs.faceLabel) && dv.docs.hasDocs && dv.docs.messenger === 'https://m.me/eve.drv', J(dv.docs));
ok('a non-admin cannot open driver documents', !box.actionAdminDriverDocs(S, { driverId: dan.DriverId }).ok);
r = box.actionAdminDriverDocs(A, { driverId: dan.DriverId });
ok('an admin sees the ID, the face photo and the signature', r.ok && /^data:image\/png;base64,/.test(r.id.dataUrl) && /^data:image\/png/.test(r.selfie.dataUrl) && r.contract.length === 1 && r.contract[0].label === 'Signature', J(r).slice(0, 200));
ok('...and the viewing is written to the audit log', Object.values(box.__sheets).find((sh) => (sh.grid[0] || []).includes('AuditId')).objects().some((a) => a.Action === 'DRIVER_DOCS_VIEWED' && a.EntityId === dan.DriverId));

/* ---------- retention: 90 days after rejection ---------- */
ok('reject Eve', box.actionAdminSetDriverStatus(A, { driverId: eve.DriverId, status: 'rejected', reason: 'Face does not match the passport' }).ok);
ok('a recent rejection keeps the documents', box.purgeOldDriverDocs() === 0 && eve.ContractFileIds.split(',').every((id) => !files[id].trashed));
const g = box.__sheets.Drivers.grid; const col = (n) => g[0].indexOf(n);
const eveRow = g.findIndex((row) => row[col('Name')] === 'Eve Driver');
g[eveRow][col('ReviewedAt')] = new Date(Date.now() - 91 * 86400000).toISOString();
ok('91 days after: the files are deleted', box.purgeOldDriverDocs() === 1 && [eve.IdFileId, eve.SelfieFileId].concat(eve.ContractFileIds.split(',')).every((id) => files[id].trashed));
const eveAfter = drivers().find((d) => d.Name === 'Eve Driver');
ok('...the row keeps the ID type and number, marked deleted', eveAfter.IdType === 'passport' && eveAfter.IdNumber === 'KR0001234' && !eveAfter.IdFileId && !!eveAfter.DocsDeletedAt);
ok('...and the admin is told they were deleted', /deleted/.test(box.actionAdminDriverDocs(A, { driverId: eve.DriverId }).error || ''));
ok('approved drivers are never purged', box.purgeOldDriverDocs() === 0 && !files[dan.IdFileId].trashed);

/* ---------- applying again after rejection ---------- */
r = apply('c-e', { name: 'Eve Driver', phone: '73000008', messenger: 'eve.drv', idType: 'kpf', idNumber: 'KPF-778' });
ok('a rejected driver can apply again with new documents', r.ok && drivers().filter((d) => d.Name === 'Eve Driver').length === 1 && drivers().find((d) => d.Name === 'Eve Driver').IdType === 'kpf', J(r));

R.forEach((x) => console.log(x[0], x[1], String(x[2]).slice(0, 300)));
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log(`${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
