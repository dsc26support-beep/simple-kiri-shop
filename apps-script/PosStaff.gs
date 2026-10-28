/**
 * Mwakete POS - staff, tills (devices), PIN sign-in and cash shifts (Oct 2026).
 * Owner decision: "the owner sets up the device, staff use a PIN".
 *
 * TILLS. The owner, signed in, registers a till. It gets a DeviceId and a long
 * random secret, shown once and kept only on that device (IndexedDB). Only a
 * hash of the secret is stored here. Revoking a till stops its secret and ends
 * every staff session on it at once.
 *
 * STAFF. The owner adds staff with a name, a role and a 4-6 digit PIN (hashed
 * with the same PBKDF2 as passwords). On a registered till a staff member
 * picks their name and types the PIN; the answer is a staff session (12 hours,
 * stored hashed) tied to that till. Wrong PINs: 5 in a row lock that person for
 * 15 minutes, and a till gets at most 20 tries in 15 minutes.
 *
 * ROLES are enforced HERE, on every POS action (posActionAllowed), not by
 * hiding buttons: owner, manager, cashier, inventory, reports
 * (POS_ROLE_PERMS in PosSync.gs).
 *
 * PENDING SALES AFTER A REVOKE. A revoked till's waiting sales stay on the
 * device. The till shows "sign in again"; the OWNER signing in on it is the
 * controlled recovery - the owner's session sends them, recorded as the owner.
 */

var POS_DEVICE_HEADERS = ['DeviceId', 'OwnerId', 'Name', 'Code', 'SecretHash', 'Status', 'CreatedBy', 'CreatedAt', 'LastSeenAt', 'RevokedAt', 'RevokedBy'];
var POS_STAFF_HEADERS = ['StaffId', 'OwnerId', 'Name', 'Role', 'PinHash', 'Status', 'FailedCount', 'LockedUntil', 'CreatedAt', 'UpdatedAt'];
var POS_SESSION_HEADERS = ['TokenHash', 'OwnerId', 'StaffId', 'DeviceId', 'Role', 'CreatedAt', 'ExpiresAt', 'RevokedAt'];
var POS_SHIFT_HEADERS = ['ShiftId', 'OwnerId', 'DeviceId', 'StaffId', 'StaffName', 'OpenedAt', 'OpeningFloat', 'Status', 'MovementsJson', 'ClosedAt', 'ClosedBy',
  'CountedCash', 'ExpectedCash', 'Variance', 'CloseNote'];
var POS_STAFF_ROLES = ['manager', 'cashier', 'inventory', 'reports'];
var POS_SESSION_HOURS = 12;

function posDevicesSheet() { return hubSheet('PosDevices', POS_DEVICE_HEADERS); }
function posStaffSheet() { return hubSheet('PosStaff', POS_STAFF_HEADERS); }
function posSessionsSheet() { return hubSheet('PosSessions', POS_SESSION_HEADERS); }
function posShiftsSheet() { return hubSheet('PosShifts', POS_SHIFT_HEADERS); }

/* ==================== Which role may call which action ==================== */

/** Server-side gate for every POS action, for owner and staff alike. '' = any POS role. */
var POS_ACTION_PERMS = {
  posSearch: '', posCatalog: '', posChanges: '', posListSales: '', posGetSale: '', posLookupTxns: '', posGetSettings: '', posStockHistory: '',
  posCheckout: 'sell', posUploadSales: 'sell', posRefundSale: 'refund', posVoidSale: 'void',
  posConfirmPayment: 'confirm_payment', posPendingPayments: 'confirm_payment',
  posListCases: 'resolve_cases', posResolveCase: 'resolve_cases', posReport: 'view_reports', posSaveSettings: 'manage_settings',
  posStockOp: '', posUpdateItem: 'edit_products', posSetProductActive: 'edit_products',
  posShiftCurrent: 'manage_shift', posOpenShift: 'manage_shift', posCashMove: 'manage_shift', posCloseShift: 'manage_shift', posListShifts: 'view_reports',
  posListStaff: 'manage_staff', posSaveStaff: 'manage_staff', posListDevices: 'manage_devices', posRegisterDevice: 'manage_devices', posRevokeDevice: 'manage_devices',
  posOnlineOrders: 'view_reports', posStaffLogout: ''
};

function posActionAllowed(action, actor) {
  if (!(action in POS_ACTION_PERMS)) return false;
  var perm = POS_ACTION_PERMS[action];
  return perm === '' ? !!POS_ROLE_PERMS[actor.role] : posCan(actor, perm);
}

/**
 * Runs a POS action for the owner (owner session) or a staff member (posToken).
 * Returns the action's answer. Called from Code.gs for every POS action.
 */
function dispatchPosAction(action, owner, actor, body) {
  if (!posActionAllowed(action, actor)) return posDenied(actor, POS_ACTION_PERMS[action] || action);
  switch (action) {
    case 'posSearch': return actionPosSearch(owner, body);
    case 'posCatalog': return actionPosCatalog(owner, body, actor);
    case 'posChanges': return actionPosChanges(owner, body);
    case 'posCheckout': return actionPosCheckout(owner, body, actor);
    case 'posUploadSales': return actionPosUploadSales(owner, body, actor);
    case 'posLookupTxns': return actionPosLookupTxns(owner, body);
    case 'posListSales': return actionPosListSales(owner, body);
    case 'posGetSale': return actionPosGetSale(owner, body);
    case 'posRefundSale': return actionPosRefundSale(owner, body, actor);
    case 'posVoidSale': return actionPosVoidSale(owner, body, actor);
    case 'posReport': return actionPosReport(owner, body);
    case 'posGetSettings': return actionPosGetSettings(owner);
    case 'posSaveSettings': return actionPosSaveSettings(owner, body);
    case 'posConfirmPayment': return actionPosConfirmPayment(owner, body, actor);
    case 'posPendingPayments': return actionPosPendingPayments(owner, body, actor);
    case 'posListCases': return actionPosListCases(owner, body, actor);
    case 'posResolveCase': return actionPosResolveCase(owner, body, actor);
    case 'posStockOp': return actionPosStockOp(owner, body, actor);
    case 'posStockHistory': return posHubEnabled() ? actionListStockMovements(owner, { variantId: body.variantId, limit: body.limit, offset: body.offset }) : hubOff();
    case 'posUpdateItem': return actionPosUpdateItem(owner, body, actor);
    case 'posSetProductActive': return actionPosSetProductActive(owner, body, actor);
    case 'posShiftCurrent': return actionPosShiftCurrent(owner, body, actor);
    case 'posOpenShift': return actionPosOpenShift(owner, body, actor);
    case 'posCashMove': return actionPosCashMove(owner, body, actor);
    case 'posCloseShift': return actionPosCloseShift(owner, body, actor);
    case 'posListShifts': return actionPosListShifts(owner, body, actor);
    case 'posListStaff': return actionPosListStaff(owner);
    case 'posSaveStaff': return actionPosSaveStaff(owner, body, actor);
    case 'posListDevices': return actionPosListDevices(owner);
    case 'posRegisterDevice': return actionPosRegisterDevice(owner, body, actor);
    case 'posRevokeDevice': return actionPosRevokeDevice(owner, body, actor);
    case 'posOnlineOrders': return actionPosOnlineOrders(owner, body);
    case 'posStaffLogout': return actionPosStaffLogout(body);
  }
  return posFail('Unknown POS action.');
}

/* ==================== Tills ==================== */

function posDeviceView(d) {
  return { deviceId: d.DeviceId, name: d.Name, code: d.Code, status: d.Status, createdAt: d.CreatedAt, lastSeenAt: d.LastSeenAt || '', revokedAt: d.RevokedAt || '' };
}

function actionPosListDevices(owner) {
  if (!posHubEnabled()) return hubOff();
  return ok({ devices: hubRows('PosDevices').filter(function (d) { return d.OwnerId === owner.OwnerId; }).map(posDeviceView) });
}

/** body: name. Answers the secret ONCE; only its hash is kept. */
function actionPosRegisterDevice(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var name = String((body && body.name) || '').trim().slice(0, 40);
  if (name.length < 2) return posFail('Give this till a name, e.g. "Front counter".');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var mine = hubRows('PosDevices').filter(function (d) { return d.OwnerId === owner.OwnerId; });
    if (mine.filter(function (d) { return d.Status === 'active'; }).length >= 20) return posFail('A store can have at most 20 active tills. Revoke one you no longer use.');
    var used = {};
    mine.forEach(function (d) { used[d.Code] = true; });
    var code = '';
    for (var tries = 0; tries < 20 && (!code || used[code]); tries++) code = Utilities.getUuid().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4);
    var deviceId = newId('dev');
    var secret = generateToken();
    appendRowFromObject(posDevicesSheet(), { DeviceId: deviceId, OwnerId: owner.OwnerId, Name: name, Code: code, SecretHash: hashSecretToken(secret), Status: 'active',
      CreatedBy: (actor && actor.name) || owner.OwnerId, CreatedAt: nowIso(), LastSeenAt: '', RevokedAt: '', RevokedBy: '' });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_DEVICE_REGISTERED', entityType: 'pos_device', entityId: deviceId, next: name });
    return ok({ device: { deviceId: deviceId, name: name, code: code, status: 'active' }, deviceSecret: secret, ownerId: owner.OwnerId, storeName: owner.StoreName || '' });
  } finally {
    lock.releaseLock();
  }
}

/** body: deviceId. Ends every staff session on it now. */
function actionPosRevokeDevice(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posDevicesSheet();
    var d = findRowById(sheet, 'DeviceId', String((body && body.deviceId) || ''));
    if (!d || d.OwnerId !== owner.OwnerId) return posFail('That till was not found.');
    if (d.Status !== 'revoked') {
      updateRowFromObject(sheet, d.__row, { Status: 'revoked', RevokedAt: nowIso(), RevokedBy: (actor && actor.name) || owner.OwnerId });
      var ss = posSessionsSheet();
      sheetToObjects(ss).forEach(function (s) { if (s.DeviceId === d.DeviceId && !s.RevokedAt) updateRowFromObject(ss, s.__row, { RevokedAt: nowIso() }); });
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_DEVICE_REVOKED', entityType: 'pos_device', entityId: d.DeviceId, next: d.Name });
    }
    return ok({ device: posDeviceView(findRowById(sheet, 'DeviceId', d.DeviceId)) });
  } finally {
    lock.releaseLock();
  }
}

/** The till's own credentials, checked. Returns the device row or null. */
function posCheckDevice(deviceId, secret) {
  if (!deviceId || !secret) return null;
  var d = findRowById(posDevicesSheet(), 'DeviceId', String(deviceId));
  if (!d || d.Status !== 'active') return null;
  return constantTimeEquals(String(d.SecretHash), hashSecretToken(String(secret))) ? d : null;
}

/* ==================== Staff ==================== */

function posStaffView(s) {
  return { staffId: s.StaffId, name: s.Name, role: s.Role, roleLabel: POS_ROLE_LABEL[s.Role] || s.Role, status: s.Status, locked: !!(s.LockedUntil && String(s.LockedUntil) > nowIso()) };
}

function actionPosListStaff(owner) {
  if (!posHubEnabled()) return hubOff();
  return ok({ staff: hubRows('PosStaff').filter(function (s) { return s.OwnerId === owner.OwnerId; }).map(posStaffView),
    roles: POS_STAFF_ROLES.map(function (r) { return { id: r, label: POS_ROLE_LABEL[r], perms: POS_ROLE_PERMS[r] }; }) });
}

/** body: staffId? (edit), name, role, pin? (4-6 digits; required for new staff), active? */
function actionPosSaveStaff(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var name = String((body && body.name) || '').trim().slice(0, 40);
  if (name.length < 2) return posFail('Enter the staff member\'s name.');
  var role = String(body.role || '');
  if (POS_STAFF_ROLES.indexOf(role) === -1) return posFail('Choose a role: manager, cashier, inventory or reports.');
  var pin = body.pin === undefined || body.pin === null || body.pin === '' ? '' : String(body.pin);
  if (pin && !/^\d{4,6}$/.test(pin)) return posFail('A PIN is 4 to 6 digits.');
  if (pin && /^(\d)\1+$/.test(pin)) return posFail('Choose a PIN that is not one digit repeated.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posStaffSheet();
    var now = nowIso();
    var staffId = String(body.staffId || '');
    if (staffId) {
      var s = findRowById(sheet, 'StaffId', staffId);
      if (!s || s.OwnerId !== owner.OwnerId) return posFail('That staff member was not found.');
      var patch = { Name: name, Role: role, Status: body.active === false ? 'disabled' : 'active', UpdatedAt: now };
      if (pin) { patch.PinHash = hashPasswordV2(pin); patch.FailedCount = 0; patch.LockedUntil = ''; }
      updateRowFromObject(sheet, s.__row, patch);
      // Disabled, or role changed: their open sessions end now.
      if (patch.Status === 'disabled' || s.Role !== role || pin) posEndStaffSessions(staffId);
    } else {
      if (!pin) return posFail('Set a 4-6 digit PIN for the new staff member.');
      if (hubRows('PosStaff').filter(function (x) { return x.OwnerId === owner.OwnerId && x.Status === 'active'; }).length >= 50) return posFail('A store can have at most 50 active staff.');
      staffId = newId('st');
      appendRowFromObject(sheet, { StaffId: staffId, OwnerId: owner.OwnerId, Name: name, Role: role, PinHash: hashPasswordV2(pin), Status: 'active', FailedCount: 0, LockedUntil: '',
        CreatedAt: now, UpdatedAt: now });
    }
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_STAFF_SAVED', entityType: 'pos_staff', entityId: staffId, next: name + ' ' + role });
    return ok({ staff: posStaffView(findRowById(sheet, 'StaffId', staffId)) });
  } finally {
    lock.releaseLock();
  }
}

function posEndStaffSessions(staffId) {
  var ss = posSessionsSheet();
  sheetToObjects(ss).forEach(function (s) { if (s.StaffId === staffId && !s.RevokedAt) updateRowFromObject(ss, s.__row, { RevokedAt: nowIso() }); });
}

/* ==================== Sign-in on a till ==================== */

/** Public (the till's secret is the credential). body: deviceId, deviceSecret. Who can sign in here. */
function actionPosDeviceInfo(body) {
  if (!posHubEnabled()) return hubOff();
  var d = posCheckDevice(body && body.deviceId, body && body.deviceSecret);
  if (!d) return posFail('This till is not registered, or it was revoked. Ask the owner to set it up again.', 'auth');
  var owner = findRowById(getSheet('Owners'), 'OwnerId', d.OwnerId);
  if (!owner || owner.Status === 'closed' || owner.Status === 'suspended') return posFail('This store is not active.', 'auth');
  return ok({ device: posDeviceView(d), store: { ownerId: owner.OwnerId, name: owner.StoreName || '' },
    staff: hubRows('PosStaff').filter(function (s) { return s.OwnerId === d.OwnerId && s.Status === 'active'; }).map(function (s) { return { staffId: s.StaffId, name: s.Name, roleLabel: POS_ROLE_LABEL[s.Role] || s.Role }; }) });
}

/** Public. body: deviceId, deviceSecret, staffId, pin. Answers a 12-hour staff session for this till. */
function actionPosStaffLogin(body) {
  if (!posHubEnabled()) return hubOff();
  var d = posCheckDevice(body && body.deviceId, body && body.deviceSecret);
  if (!d) return posFail('This till is not registered, or it was revoked. Ask the owner to set it up again.', 'auth');
  var cache = CacheService.getScriptCache();
  var key = 'pospin:' + d.DeviceId;
  var tries = Number(cache.get(key)) || 0;
  if (tries >= 20) return posFail('Too many PIN attempts on this till. Wait 15 minutes.', 'rate');
  cache.put(key, String(tries + 1), 900);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posStaffSheet();
    var s = findRowById(sheet, 'StaffId', String(body.staffId || ''));
    if (!s || s.OwnerId !== d.OwnerId || s.Status !== 'active') return posFail('Wrong name or PIN.', 'auth');
    if (s.LockedUntil && String(s.LockedUntil) > nowIso()) return posFail('Too many wrong PINs. Try again in 15 minutes, or ask the owner.', 'rate');
    if (!verifyPassword(String(body.pin || ''), s.PinHash)) {
      var failed = (Number(s.FailedCount) || 0) + 1;
      updateRowFromObject(sheet, s.__row, { FailedCount: failed >= 5 ? 0 : failed, LockedUntil: failed >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : '' });
      if (failed >= 5) appendAudit({ actorId: s.StaffId, actorRole: 'pos_' + s.Role, action: 'POS_PIN_LOCKED', entityType: 'pos_staff', entityId: s.StaffId });
      return posFail('Wrong name or PIN.', 'auth');
    }
    updateRowFromObject(sheet, s.__row, { FailedCount: 0, LockedUntil: '' });
    var token = generateToken();
    var expires = new Date(Date.now() + POS_SESSION_HOURS * 3600000).toISOString();
    appendRowFromObject(posSessionsSheet(), { TokenHash: hashSecretToken(token), OwnerId: d.OwnerId, StaffId: s.StaffId, DeviceId: d.DeviceId, Role: s.Role, CreatedAt: nowIso(), ExpiresAt: expires, RevokedAt: '' });
    updateRowFromObject(posDevicesSheet(), findRowById(posDevicesSheet(), 'DeviceId', d.DeviceId).__row, { LastSeenAt: nowIso() });
    appendAudit({ actorId: s.StaffId, actorRole: 'pos_' + s.Role, action: 'POS_STAFF_SIGNED_IN', entityType: 'pos_device', entityId: d.DeviceId, next: s.Name });
    var owner = findRowById(getSheet('Owners'), 'OwnerId', d.OwnerId);
    return ok({ posToken: token, expiresAt: expires, staff: { staffId: s.StaffId, name: s.Name, role: s.Role, roleLabel: POS_ROLE_LABEL[s.Role] },
      store: { ownerId: d.OwnerId, name: owner ? owner.StoreName : '' }, device: posDeviceView(d) });
  } finally {
    lock.releaseLock();
  }
}

function actionPosStaffLogout(body) {
  var ss = posSessionsSheet();
  var row = findRowBySecret(ss, 'TokenHash', hashSecretToken(String((body && body.posToken) || '')));
  if (row && !row.RevokedAt) updateRowFromObject(ss, row.__row, { RevokedAt: nowIso() });
  return ok({});
}

/**
 * A staff session -> { owner, actor } or throws. Checks: session not revoked or
 * expired, staff still active with the same role, till still active, store
 * still open.
 */
function requirePosSession(posToken, deviceSecret) {
  if (!posHubEnabled()) throw new Error('The POS & Integrations feature is not switched on yet.');
  var row = findRowBySecret(posSessionsSheet(), 'TokenHash', hashSecretToken(String(posToken || '')));
  if (!row || row.RevokedAt || String(row.ExpiresAt) < nowIso()) throw new Error('Your till session has ended. Sign in again with your PIN.');
  var d = findRowById(posDevicesSheet(), 'DeviceId', row.DeviceId);
  if (!d || d.Status !== 'active') throw new Error('This till was revoked by the owner. Sign in again after the owner sets it up.');
  // The session works only from the till it was opened on.
  if (!constantTimeEquals(String(d.SecretHash), hashSecretToken(String(deviceSecret || '')))) throw new Error('Your till session has ended. Sign in again with your PIN.');
  var s = findRowById(posStaffSheet(), 'StaffId', row.StaffId);
  if (!s || s.Status !== 'active' || s.Role !== row.Role) throw new Error('Your till session has ended. Sign in again with your PIN.');
  var owner = findRowById(getSheet('Owners'), 'OwnerId', row.OwnerId);
  if (!owner || owner.Status === 'closed' || owner.Status === 'suspended') throw new Error('This store is not active.');
  return { owner: owner, actor: { role: s.Role, id: s.StaffId, name: s.Name + ' (' + (POS_ROLE_LABEL[s.Role] || s.Role).toLowerCase() + ')', deviceId: d.DeviceId } };
}

/* ==================== Cash shifts ==================== */

function posShiftView(sh) {
  return { shiftId: sh.ShiftId, deviceId: sh.DeviceId, staffName: sh.StaffName, openedAt: sh.OpenedAt, openingFloat: Number(sh.OpeningFloat) || 0, status: sh.Status,
    movements: hubParse(sh.MovementsJson, []), closedAt: sh.ClosedAt || '', closedBy: sh.ClosedBy || '', countedCash: sh.CountedCash === '' ? null : Number(sh.CountedCash),
    expectedCash: sh.ExpectedCash === '' ? null : Number(sh.ExpectedCash), variance: sh.Variance === '' ? null : Number(sh.Variance), closeNote: sh.CloseNote || '' };
}

/** Cash the drawer should hold: float + cash sales paid in the shift - cash refunds of them + cash in - cash out. */
function posExpectedCash(owner, sh) {
  var sales = hubRows('PosSales').filter(function (s) { return s.OwnerId === owner.OwnerId && s.ShiftId === sh.ShiftId; });
  var ids = {};
  sales.forEach(function (s) { ids[s.SaleId] = s; });
  var cashIn = hubRows('PosPayments').filter(function (p) { return ids[p.SaleId] && p.Method === 'cash' && (p.Status === 'paid' || p.Status === 'received' || p.Status === 'refunded'); })
    .reduce(function (n, p) { return n + (Number(p.Amount) || 0); }, 0);
  // Money handed back for cash sales: refunds and voids.
  var back = hubRows('PosRefunds').filter(function (r) { return ids[r.SaleId] && ids[r.SaleId].PaymentMethod === 'cash'; }).reduce(function (n, r) { return n + (Number(r.Amount) || 0); }, 0);
  back += sales.filter(function (s) { return s.Status === 'voided' && s.PaymentMethod === 'cash'; }).reduce(function (n, s) { return n + (Number(s.PaidAmount) || Number(s.Total) || 0); }, 0);
  var moves = hubParse(sh.MovementsJson, []).reduce(function (n, m) { return n + (m.type === 'in' ? 1 : -1) * (Number(m.amount) || 0); }, 0);
  return roundMoney((Number(sh.OpeningFloat) || 0) + cashIn - back + moves);
}

function posOpenShiftFor(owner, actor) {
  return hubRows('PosShifts').filter(function (s) { return s.OwnerId === owner.OwnerId && s.Status === 'open' && s.DeviceId === (actor.deviceId || 'dashboard'); })[0] || null;
}

function actionPosShiftCurrent(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var sh = posOpenShiftFor(owner, actor);
  return ok({ shift: sh ? Object.assign(posShiftView(sh), { expectedCash: posExpectedCash(owner, sh) }) : null });
}

/** body: openingFloat */
function actionPosOpenShift(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var f = Number(body && body.openingFloat);
  if (!isFinite(f) || f < 0 || f > 100000) return posFail('Enter the cash in the drawer at the start (0 or more).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var open = posOpenShiftFor(owner, actor);
    if (open) return ok({ shift: posShiftView(open), alreadyOpen: true });
    var id = newId('shift');
    appendRowFromObject(posShiftsSheet(), { ShiftId: id, OwnerId: owner.OwnerId, DeviceId: actor.deviceId || 'dashboard', StaffId: actor.id, StaffName: actor.name, OpenedAt: nowIso(),
      OpeningFloat: roundMoney(f), Status: 'open', MovementsJson: '[]', ClosedAt: '', ClosedBy: '', CountedCash: '', ExpectedCash: '', Variance: '', CloseNote: '' });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: 'POS_SHIFT_OPENED', entityType: 'pos_shift', entityId: id, next: String(roundMoney(f)) });
    return ok({ shift: posShiftView(findRowById(posShiftsSheet(), 'ShiftId', id)) });
  } finally {
    lock.releaseLock();
  }
}

/** body: shiftId, type ('in' | 'out'), amount, reason */
function actionPosCashMove(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var amount = Number(body && body.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 100000) return posFail('Enter an amount above $0.');
  if (body.type !== 'in' && body.type !== 'out') return posFail('Choose cash in or cash out.');
  var reason = String(body.reason || '').trim().slice(0, 80);
  if (reason.length < 3) return posFail('Say why, e.g. "paid the bread delivery".');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posShiftsSheet();
    var sh = findRowById(sheet, 'ShiftId', String(body.shiftId || ''));
    if (!sh || sh.OwnerId !== owner.OwnerId || sh.Status !== 'open') return posFail('That shift is not open.');
    var moves = hubParse(sh.MovementsJson, []);
    if (moves.length >= 200) return posFail('Too many cash movements on one shift. Close it and open a new one.');
    moves.push({ type: body.type, amount: roundMoney(amount), reason: reason, by: actor.name, at: nowIso() });
    updateRowFromObject(sheet, sh.__row, { MovementsJson: JSON.stringify(moves) });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: 'POS_CASH_' + body.type.toUpperCase(), entityType: 'pos_shift', entityId: sh.ShiftId, next: String(roundMoney(amount)), reason: reason });
    var fresh = findRowById(sheet, 'ShiftId', sh.ShiftId);
    return ok({ shift: Object.assign(posShiftView(fresh), { expectedCash: posExpectedCash(owner, fresh) }) });
  } finally {
    lock.releaseLock();
  }
}

/** body: shiftId, countedCash, note? */
function actionPosCloseShift(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var counted = Number(body && body.countedCash);
  if (!isFinite(counted) || counted < 0) return posFail('Count the cash in the drawer and enter it.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posShiftsSheet();
    var sh = findRowById(sheet, 'ShiftId', String(body.shiftId || ''));
    if (!sh || sh.OwnerId !== owner.OwnerId) return posFail('That shift was not found.');
    if (sh.Status === 'closed') return ok({ shift: posShiftView(sh), replayed: true });
    var expected = posExpectedCash(owner, sh);
    var variance = roundMoney(counted - expected);
    updateRowFromObject(sheet, sh.__row, { Status: 'closed', ClosedAt: nowIso(), ClosedBy: actor.name, CountedCash: roundMoney(counted), ExpectedCash: expected, Variance: variance,
      CloseNote: String(body.note || '').trim().slice(0, 200) });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: 'POS_SHIFT_CLOSED', entityType: 'pos_shift', entityId: sh.ShiftId, next: 'counted ' + counted + ' expected ' + expected + ' variance ' + variance });
    return ok({ shift: posShiftView(findRowById(sheet, 'ShiftId', sh.ShiftId)) });
  } finally {
    lock.releaseLock();
  }
}

function actionPosListShifts(owner, body) {
  if (!posHubEnabled()) return hubOff();
  return ok({ shifts: hubRows('PosShifts').filter(function (s) { return s.OwnerId === owner.OwnerId; })
    .sort(function (a, b) { return String(b.OpenedAt).localeCompare(String(a.OpenedAt)); }).slice(0, 60).map(posShiftView) });
}

/* ==================== Online orders (read only, kept separate) ==================== */

/**
 * The store's open online orders, for the till to SEE. They are not in-store
 * sales and are never completed here: they are handled in Orders, with their
 * own payment and delivery flow.
 */
function actionPosOnlineOrders(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var tab = SpreadsheetApp.getActive().getSheetByName('Orders');
  var open = (tab ? sheetToObjects(tab) : []).filter(function (o) { return o.OwnerId === owner.OwnerId && ['Pending Payment', 'Paid'].indexOf(String(o.Status)) !== -1; })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); }).slice(0, 50);
  return ok({ orders: open.map(function (o) {
    return { orderId: o.OrderId, orderNumber: o.OrderId, status: o.Status, total: Number(o.Total) || 0, createdAt: o.CreatedAt, customerName: o.CustomerName || '',
      delivery: o.DeliveryMethod || o.Fulfilment || '', channel: 'online' };
  }) });
}
