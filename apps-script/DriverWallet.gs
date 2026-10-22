/**
 * Driver wallet: the money ledger behind "Drive with Mwakete" payments
 * (phase 1 of docs/driver-wallet.md, Oct 2026). Pure ledger maths and
 * switches only - no endpoint calls into this yet, so deploying it changes
 * nothing a user can see.
 *
 * THE MODEL - small and checkable by hand:
 *  - The seller and the driver agree a delivery fee; the seller pays that fee
 *    to Mwakete by bank transfer; an admin confirms it against the real bank
 *    statement (later phases). When the buyer confirms receipt, the fee is
 *    CREDITED to the driver here, but only becomes AVAILABLE after a dispute
 *    hold (default 48 hours).
 *  - A driver CLAIMS their available balance once it reaches the minimum
 *    payout (default $20). An admin pays it by bank transfer and records the
 *    bank reference (PAYOUT_PAID).
 *  - Commission is 0% at launch. The ledger already records GrossFee and
 *    Commission on every credit so it can be switched on later with no
 *    migration.
 *
 * THE LEDGER IS THE ONLY TRUTH. A balance is never stored; it is always added
 * up from DriverLedger. Rows are only ever appended, never edited or removed.
 * A mistake is fixed with a new ADJUSTMENT row that has a reason.
 *
 * ROLLOUT: Script Property DELIVERY_PAYMENTS = off (default) | pilot | on.
 *  pilot  = only the DriverIds in DELIVERY_PAYMENTS_DRIVERS (at most 5) and
 *           only on South Tarawa. on = every approved driver.
 * Other Script Properties:
 *  DRIVER_MIN_PAYOUT        minimum claim, default 20
 *  DRIVER_HOLD_HOURS        dispute hold before a credit is available, default 48
 *  DRIVER_COMMISSION_PCT    default 0
 *
 * Mwakete's wording elsewhere (terms, order room) still says it never holds
 * money. That wording MUST be updated before DELIVERY_PAYMENTS is turned on
 * (phase 5), and legal advice taken first.
 *
 * TAB (created on first use, additive):
 *   DriverLedger  EntryId | DriverId | JobId | OrderId | EntryType | Amount | GrossFee
 *                 | Commission | Currency | AvailableAt | RefEntryId | Reference
 *                 | IdempotencyKey | Note | By | CreatedAt
 *
 * ENTRY TYPES (Amount is signed; money owed to the driver is positive):
 *   CREDIT        + net fee for a delivered job. AvailableAt = credit time + hold.
 *   CLAIM         - the amount the driver asked to be paid. Holds that money.
 *   PAYOUT_PAID   0 marker: the admin paid CLAIM RefEntryId; Reference = bank reference.
 *   CLAIM_REVERSED + gives a claim back (admin: wrong bank details, bounced transfer).
 *   ADJUSTMENT    +/- admin correction. A Note (the reason) is required.
 *
 * Callers MUST hold the script lock (LockService.getScriptLock) around any
 * write here, as runDriverWrite and runTxWrite do, so two requests cannot
 * both read the same balance.
 */

var WALLET_LEDGER_HEADERS = ['EntryId', 'DriverId', 'JobId', 'OrderId', 'EntryType', 'Amount', 'GrossFee', 'Commission', 'Currency',
  'AvailableAt', 'RefEntryId', 'Reference', 'IdempotencyKey', 'Note', 'By', 'CreatedAt'];
var WALLET_CURRENCY = 'AUD';
var WALLET_DEFAULT_MIN_PAYOUT = 20;
var WALLET_DEFAULT_HOLD_HOURS = 48;
var WALLET_PILOT_MAX_DRIVERS = 5;
var WALLET_PILOT_ISLAND = 'South Tarawa';

function walletLedgerSheet() { return getSheetCreating('DriverLedger', WALLET_LEDGER_HEADERS); }

function walletMoney(v) { return roundMoney(Number(v) || 0); }

function walletProp(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v === null || v === undefined ? '' : String(v).trim();
}

/** off | pilot | on. Anything else is off. */
function walletMode() {
  var v = walletProp('DELIVERY_PAYMENTS').toLowerCase();
  return v === 'on' || v === 'pilot' ? v : 'off';
}

function walletPilotDrivers() {
  return walletProp('DELIVERY_PAYMENTS_DRIVERS').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    .slice(0, WALLET_PILOT_MAX_DRIVERS);
}

/** Whether wallet payments apply to this driver row (from the Drivers tab). */
function walletEnabledForDriver(driver) {
  var mode = walletMode();
  if (mode === 'on') return true;
  if (mode !== 'pilot' || !driver) return false;
  if (islandKey(driver.Area) !== islandKey(WALLET_PILOT_ISLAND)) return false;
  return walletPilotDrivers().indexOf(String(driver.DriverId)) !== -1;
}

function walletPositiveNumber(name, fallback, min, max) {
  var raw = walletProp(name);
  if (raw === '') return fallback;
  var n = Number(raw);
  return isFinite(n) && n >= min && n <= max ? n : fallback;
}

function walletMinPayout() { return walletMoney(walletPositiveNumber('DRIVER_MIN_PAYOUT', WALLET_DEFAULT_MIN_PAYOUT, 1, 10000)); }
function walletHoldHours() { return walletPositiveNumber('DRIVER_HOLD_HOURS', WALLET_DEFAULT_HOLD_HOURS, 0, 720); }
function walletCommissionPct() { return walletPositiveNumber('DRIVER_COMMISSION_PCT', 0, 0, 100); }

function walletEntries(driverId) {
  var s = SpreadsheetApp.getActive().getSheetByName('DriverLedger');
  if (!s) return [];
  var all = sheetToObjects(s);
  return driverId ? all.filter(function (e) { return e.DriverId === driverId; }) : all;
}

/** Appends one ledger row. Returns the row, or null when its IdempotencyKey already exists (a repeat). */
function walletAppend(entry) {
  if (!entry.DriverId || !entry.EntryType) throw new Error('A ledger row needs a driver and a type');
  var key = String(entry.IdempotencyKey || '');
  if (!key) throw new Error('A ledger row needs an idempotency key');
  var sheet = walletLedgerSheet();
  if (sheetToObjects(sheet).some(function (r) { return r.IdempotencyKey === key; })) return null;
  var row = Object.assign({ EntryId: newId('wal'), Currency: WALLET_CURRENCY, CreatedAt: nowIso(), By: 'system' }, entry,
    { Amount: walletMoney(entry.Amount) });
  appendRowFromObject(sheet, row);
  return row;
}

/**
 * What a driver is owed, added up from the ledger.
 *  total       credits and corrections, less every claim (paid or not)
 *  available   the part of total whose hold has ended - what they may claim now
 *  pending     still inside the dispute hold
 *  claimed     claims not yet paid and not reversed (an admin owes this)
 *  paidOut     claims an admin has marked paid
 */
function walletBalance(driverId, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var rows = walletEntries(driverId);
  var paid = {}, reversed = {};
  rows.forEach(function (e) {
    if (e.EntryType === 'PAYOUT_PAID') paid[e.RefEntryId] = true;
    if (e.EntryType === 'CLAIM_REVERSED') reversed[e.RefEntryId] = true;
  });
  var total = 0, available = 0, claimed = 0, paidOut = 0;
  rows.forEach(function (e) {
    var amt = walletMoney(e.Amount);
    if (e.EntryType === 'PAYOUT_PAID') return;
    if (e.EntryType === 'CLAIM' && !reversed[e.EntryId]) {
      if (paid[e.EntryId]) paidOut += -amt; else claimed += -amt;
    }
    // total and available both go down the moment a claim is made, so the
    // same money can never be claimed twice. A credit is available once its
    // hold has ended; every other row applies at once.
    total += amt;
    var at = e.AvailableAt ? Date.parse(e.AvailableAt) : 0;
    if (amt < 0 || !isFinite(at) || at <= now) available += amt;
  });
  total = walletMoney(total);
  available = walletMoney(available);
  return { total: total, available: available, pending: walletMoney(total - available), claimed: walletMoney(claimed),
    paidOut: walletMoney(paidOut), currency: WALLET_CURRENCY, minPayout: walletMinPayout() };
}

/**
 * Credit a delivered job's fee to its driver. Safe to call again: a job is
 * credited once. Returns { ok, entry } or { ok:false, error }.
 */
function walletCreditJob(job, nowMs) {
  if (!job || !job.JobId || !job.DriverId) return { ok: false, error: 'This job has no driver.' };
  if (String(job.Status) !== 'delivered') return { ok: false, error: 'Only a delivered job can be credited.' };
  var gross = walletMoney(job.Fee);
  if (gross <= 0) return { ok: false, error: 'This job has no fee to credit.' };
  var now = nowMs === undefined ? Date.now() : nowMs;
  var commission = walletMoney(gross * walletCommissionPct() / 100);
  var entry = walletAppend({ DriverId: job.DriverId, JobId: job.JobId, OrderId: job.OrderId, EntryType: 'CREDIT',
    Amount: gross - commission, GrossFee: gross, Commission: commission,
    AvailableAt: new Date(now + walletHoldHours() * 3600000).toISOString(), IdempotencyKey: 'credit:' + job.JobId });
  return entry ? { ok: true, entry: entry } : { ok: true, entry: null, alreadyCredited: true };
}

/**
 * The driver asks to be paid their whole available balance. Needs the
 * minimum. requestId makes a double tap the same claim.
 */
function walletClaim(driverId, requestId, nowMs, note) {
  var rid = String(requestId || '').trim();
  if (!rid) return { ok: false, error: 'A request id is needed.' };
  var key = 'claim:' + driverId + ':' + rid;
  // A double tap sends the same request id: answer with the claim already made.
  var prior = walletEntries(driverId).filter(function (e) { return e.IdempotencyKey === key; })[0];
  if (prior) return { ok: true, entry: null, repeated: true, balance: walletBalance(driverId, nowMs) };
  var bal = walletBalance(driverId, nowMs);
  if (bal.available < bal.minPayout) {
    return { ok: false, error: 'You can claim once you have ' + bal.minPayout + ' available. You have ' + bal.available + '.', balance: bal };
  }
  var entry = walletAppend({ DriverId: driverId, EntryType: 'CLAIM', Amount: -bal.available, Note: String(note || '').slice(0, 300), IdempotencyKey: key, By: driverId });
  return { ok: true, entry: entry, balance: walletBalance(driverId, nowMs) };
}

function walletFindClaim(claimId) {
  var c = walletEntries().filter(function (e) { return e.EntryId === claimId && e.EntryType === 'CLAIM'; })[0];
  if (!c) return { error: 'Claim not found.' };
  var closed = walletEntries(c.DriverId).filter(function (e) { return e.RefEntryId === claimId && (e.EntryType === 'PAYOUT_PAID' || e.EntryType === 'CLAIM_REVERSED'); })[0];
  if (closed) return { error: closed.EntryType === 'PAYOUT_PAID' ? 'This claim is already paid.' : 'This claim was already reversed.' };
  return { claim: c };
}

/** Admin: the bank transfer for a claim has been made. */
function walletMarkClaimPaid(claimId, bankReference, adminId) {
  var ref = String(bankReference || '').trim();
  if (ref.length < 3) return { ok: false, error: 'Enter the bank reference of the transfer.' };
  var found = walletFindClaim(claimId);
  if (found.error) return { ok: false, error: found.error };
  var entry = walletAppend({ DriverId: found.claim.DriverId, EntryType: 'PAYOUT_PAID', Amount: 0, RefEntryId: claimId, Reference: ref,
    IdempotencyKey: 'paid:' + claimId, By: adminId || 'admin' });
  return { ok: true, entry: entry };
}

/** Admin: give an unpaid claim back to the driver's balance. A reason is required. */
function walletReverseClaim(claimId, reason, adminId) {
  var why = String(reason || '').trim();
  if (why.length < 5) return { ok: false, error: 'Say why the claim is being reversed.' };
  var found = walletFindClaim(claimId);
  if (found.error) return { ok: false, error: found.error };
  var entry = walletAppend({ DriverId: found.claim.DriverId, EntryType: 'CLAIM_REVERSED', Amount: -walletMoney(found.claim.Amount), RefEntryId: claimId,
    Note: why, IdempotencyKey: 'reverse:' + claimId, By: adminId || 'admin' });
  return { ok: true, entry: entry };
}

/** Admin correction, positive or negative, applied at once. A reason is required. */
function walletAdjust(driverId, amount, reason, adminId, requestId) {
  var amt = walletMoney(amount);
  var why = String(reason || '').trim();
  if (!amt) return { ok: false, error: 'Enter an amount that is not zero.' };
  if (why.length < 5) return { ok: false, error: 'Say why the balance is being adjusted.' };
  if (!String(requestId || '').trim()) return { ok: false, error: 'A request id is needed.' };
  var entry = walletAppend({ DriverId: driverId, EntryType: 'ADJUSTMENT', Amount: amt, Note: why,
    IdempotencyKey: 'adjust:' + driverId + ':' + requestId, By: adminId || 'admin' });
  return { ok: true, entry: entry, repeated: !entry };
}
