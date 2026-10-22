/**
 * Driver wallet ledger (DriverWallet.gs, phase 1) on the REAL backend
 * sources: switches, crediting a delivered job once, the dispute hold, the
 * minimum payout, claiming, paying, reversing, adjusting, and that balances
 * are always added up from an append-only ledger.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const box = makeBox({});
const H = 3600000;
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const job = (id, fee, extra) => Object.assign({ JobId: id, OrderId: 'ord_' + id, DriverId: 'drv_1', Status: 'delivered', Fee: fee }, extra || {});
const ledger = () => (box.__sheets.DriverLedger ? box.__sheets.DriverLedger.objects() : []);

/* ---- switches ---- */
ok('off by default', box.walletMode() === 'off');
box.__props.DELIVERY_PAYMENTS = 'sometimes';
ok('an unknown value is off', box.walletMode() === 'off');
const drv = (id, area) => ({ DriverId: id, Area: area || 'South Tarawa' });
ok('off: no driver is enabled', !box.walletEnabledForDriver(drv('drv_1')));
box.__props.DELIVERY_PAYMENTS = 'pilot';
ok('pilot with no list: nobody', !box.walletEnabledForDriver(drv('drv_1')));
box.__props.DELIVERY_PAYMENTS_DRIVERS = 'drv_1, drv_2,drv_3,drv_4,drv_5,drv_6';
ok('pilot: a listed South Tarawa driver is in', box.walletEnabledForDriver(drv('drv_1')));
ok('pilot: only the first 5 listed count', !box.walletEnabledForDriver(drv('drv_6')) && box.walletEnabledForDriver(drv('drv_5')));
ok('pilot: a listed driver on another island is out', !box.walletEnabledForDriver(drv('drv_1', 'Abemama')));
ok('pilot: an unlisted driver is out', !box.walletEnabledForDriver(drv('drv_9')));
box.__props.DELIVERY_PAYMENTS = 'on';
ok('on: every driver', box.walletEnabledForDriver(drv('drv_9', 'Abemama')));

/* ---- settings ---- */
ok('defaults: $20 minimum, 48h hold, 0% commission', box.walletMinPayout() === 20 && box.walletHoldHours() === 48 && box.walletCommissionPct() === 0);
box.__props.DRIVER_MIN_PAYOUT = 'banana'; box.__props.DRIVER_HOLD_HOURS = '-5'; box.__props.DRIVER_COMMISSION_PCT = '500';
ok('bad settings fall back to the defaults', box.walletMinPayout() === 20 && box.walletHoldHours() === 48 && box.walletCommissionPct() === 0);
box.__props.DRIVER_MIN_PAYOUT = '15';
ok('a good setting is used', box.walletMinPayout() === 15);
delete box.__props.DRIVER_MIN_PAYOUT; delete box.__props.DRIVER_HOLD_HOURS; delete box.__props.DRIVER_COMMISSION_PCT;

/* ---- crediting ---- */
let r = box.walletCreditJob(job('a', 12), T0);
ok('a delivered job is credited its fee', r.ok && r.entry.Amount === 12 && r.entry.GrossFee === 12 && r.entry.Commission === 0, J(r));
ok('...held for 48 hours', r.entry.AvailableAt === new Date(T0 + 48 * H).toISOString());
let b = box.walletBalance('drv_1', T0 + 1 * H);
ok('inside the hold: pending, not available', b.total === 12 && b.available === 0 && b.pending === 12, J(b));
b = box.walletBalance('drv_1', T0 + 48 * H);
ok('when the hold ends: available', b.available === 12 && b.pending === 0, J(b));
r = box.walletCreditJob(job('a', 12), T0 + 5 * H);
ok('crediting the same job again changes nothing', r.ok && r.alreadyCredited && ledger().length === 1, J(r));
ok('a job that is not delivered is refused', !box.walletCreditJob(job('b', 5, { Status: 'picked_up' }), T0).ok);
ok('a job with no driver is refused', !box.walletCreditJob(job('b', 5, { DriverId: '' }), T0).ok);
ok('a job with no fee is refused', !box.walletCreditJob(job('b', 0), T0).ok);
ok('refusals wrote nothing', ledger().length === 1);

/* ---- commission is ready but off ---- */
box.__props.DRIVER_COMMISSION_PCT = '10';
r = box.walletCreditJob(job('c', 10, { DriverId: 'drv_3' }), T0);
ok('10% commission: driver gets 9, gross and commission are recorded', r.entry.Amount === 9 && r.entry.GrossFee === 10 && r.entry.Commission === 1, J(r));
delete box.__props.DRIVER_COMMISSION_PCT;

/* ---- claiming ---- */
r = box.walletClaim('drv_1', 'req1', T0 + 48 * H);
ok('below the minimum: refused, nothing written', !r.ok && /20/.test(r.error) && ledger().length === 2, J(r));

box.walletCreditJob(job('d', 11), T0);
b = box.walletBalance('drv_1', T0 + 48 * H);
ok('two credits add up (12 + 11 = 23)', b.total === 23 && b.available === 23, J(b));
r = box.walletClaim('drv_1', '', T0 + 48 * H);
ok('a claim needs a request id', !r.ok);
r = box.walletClaim('drv_1', 'req1', T0 + 48 * H);
ok('at or above the minimum: the whole available balance is claimed', r.ok && r.entry.Amount === -23, J(r));
b = r.balance;
ok('after a claim: available 0, claimed 23', b.available === 0 && b.claimed === 23 && b.total === 0, J(b));
r = box.walletClaim('drv_1', 'req1', T0 + 48 * H);
ok('the same request again is the same claim (a double tap)', r.ok && r.repeated && ledger().filter((e) => e.EntryType === 'CLAIM').length === 1, J(r));
r = box.walletClaim('drv_1', 'req2', T0 + 48 * H);
ok('a second claim with nothing left is refused', !r.ok);

/* ---- pending credit is not claimable ---- */
box.walletCreditJob(job('e', 30), T0 + 100 * H);
r = box.walletClaim('drv_1', 'req3', T0 + 101 * H);
ok('a credit still in its hold cannot be claimed', !r.ok && box.walletBalance('drv_1', T0 + 101 * H).pending === 30);

/* ---- paying and reversing ---- */
const claimId = ledger().find((e) => e.EntryType === 'CLAIM').EntryId;
ok('paying needs a bank reference', !box.walletMarkClaimPaid(claimId, '  ', 'adm').ok);
ok('paying an unknown claim is refused', !box.walletMarkClaimPaid('nope', 'ANZ-123', 'adm').ok);
r = box.walletMarkClaimPaid(claimId, 'ANZ-123456', 'adm');
b = box.walletBalance('drv_1', T0 + 101 * H);
ok('marking a claim paid moves it from claimed to paid out', r.ok && b.claimed === 0 && b.paidOut === 23, J(b));
ok('paying twice is refused', !box.walletMarkClaimPaid(claimId, 'ANZ-123456', 'adm').ok);
ok('a paid claim cannot be reversed', !box.walletReverseClaim(claimId, 'changed my mind', 'adm').ok);

box.walletCreditJob(job('f', 25), T0);
box.walletClaim('drv_1', 'req4', T0 + 200 * H);
const claim2 = ledger().filter((e) => e.EntryType === 'CLAIM')[1];
ok('reversing needs a reason', !box.walletReverseClaim(claim2.EntryId, 'no', 'adm').ok);
r = box.walletReverseClaim(claim2.EntryId, 'Bank details were wrong', 'adm');
b = box.walletBalance('drv_1', T0 + 200 * H);
ok('a reversed claim returns the money, and is no longer owed', r.ok && b.claimed === 0 && b.available === 25 + 30, J(b));
ok('reversing twice is refused', !box.walletReverseClaim(claim2.EntryId, 'Bank details were wrong', 'adm').ok);
ok('paying a reversed claim is refused', !box.walletMarkClaimPaid(claim2.EntryId, 'ANZ-999', 'adm').ok);

/* ---- adjustments ---- */
ok('an adjustment needs a reason, an amount and a request id',
  !box.walletAdjust('drv_1', 5, 'x', 'adm', 'r1').ok && !box.walletAdjust('drv_1', 0, 'Correct a typo', 'adm', 'r1').ok && !box.walletAdjust('drv_1', 5, 'Correct a typo', 'adm', '').ok);
const before = box.walletBalance('drv_1', T0 + 200 * H).available;
r = box.walletAdjust('drv_1', -5, 'Fee was entered wrongly', 'adm', 'r1');
ok('a negative adjustment applies at once', r.ok && box.walletBalance('drv_1', T0 + 200 * H).available === before - 5);
r = box.walletAdjust('drv_1', -5, 'Fee was entered wrongly', 'adm', 'r1');
ok('the same adjustment request is not applied twice', r.ok && r.repeated && box.walletBalance('drv_1', T0 + 200 * H).available === before - 5);

/* ---- the ledger is append-only and per driver ---- */
box.walletCreditJob(job('z', 40, { DriverId: 'drv_2' }), T0);
ok('another driver has their own balance', box.walletBalance('drv_2', T0 + 48 * H).available === 40);
ok('and the first is unaffected', box.walletBalance('drv_1', T0 + 200 * H).available === before - 5);
const ids = ledger().map((e) => e.EntryId);
ok('every entry has a unique id', new Set(ids).size === ids.length);
let threw = false; try { box.walletAppend({ DriverId: 'drv_1', EntryType: 'CREDIT', Amount: 1 }); } catch (e) { threw = true; }
ok('a row with no idempotency key is rejected', threw);
ok('the file is probed by checkSetup', box.actionCheckSetup().missingFiles.indexOf('DriverWallet.gs') === -1);
ok('and the version moved on', /^wallet1-/.test(box.APP_VERSION));

R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' ? '  ' + x[2] : '')));
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
