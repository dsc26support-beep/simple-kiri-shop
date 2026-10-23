/**
 * "Become a Seller" applications (owner decision, Oct 2026).
 *
 * An application IS the store row in Owners, with ApprovalStatus:
 *   pending   - applied (actionRegisterOwner, Auth.gs); cannot log in or sell,
 *               hidden from shoppers
 *   approved  - a normal store (blank also reads as approved: every store
 *               from before applications existed - ownerApprovalStatus)
 *   rejected  - not approved; the applicant may apply again (same row)
 *   suspended - an approved store an admin has stopped; locked out and hidden
 * Owners.CustomerId links the store to the shopper account that applied.
 *
 * Only an admin (isOwnerAdmin - checked HERE, on the server, for every call)
 * may approve, reject, suspend or reinstate. An admin's own store can never be
 * suspended or rejected from here, so nobody can lock the last admin out.
 * Every decision is written to AuthEvents (logAuthEvent).
 */

var SELLER_REVIEW_NOTE_MAX = 500;

/** What the applicant (and the admin list) may see of an application. */
function sellerApplicationView(owner) {
  return {
    ownerId: owner.OwnerId,
    storeName: owner.StoreName,
    storeSlug: owner.StoreSlug,
    storeType: storeTypeOf(owner),
    status: ownerApprovalStatus(owner),
    appliedAt: owner.AppliedAt || '',
    reviewedAt: owner.ReviewedAt || '',
    reviewNote: owner.ReviewNote || ''
  };
}

/** The admin list adds what an admin needs to decide. Never a password field. */
function sellerApplicationAdminView(owner) {
  return Object.assign(sellerApplicationView(owner), {
    username: owner.Username,
    email: owner.Email,
    phone: owner.Phone,
    messenger: owner.Messenger || '',
    about: owner.ApplicationNote || '',
    customerId: owner.CustomerId || '',
    reviewedBy: owner.ReviewedBy || ''
  });
}

/**
 * Best-effort emails about an application. kind: received | approved |
 * rejected | suspended | reinstated. A failed send never undoes the decision.
 */
function notifySellerApplication(owner, kind) {
  var base = siteBaseUrl();
  var portal = base ? base + '/owner/login.html' : '';
  var note = owner.ReviewNote ? '\n\nNote from Mwakete: ' + owner.ReviewNote : '';
  var lines = {
    received: ['We received your application to sell on Mwakete',
      'Thank you for applying to open "' + owner.StoreName + '" on Mwakete.\n\n' +
      'We will review it and email you when it is decided. Your store is not visible to shoppers until it is approved.'],
    approved: ['Your Mwakete store is approved',
      'Good news - "' + owner.StoreName + '" is approved.\n\n' +
      'Log in with the store username and password you chose' + (portal ? ': ' + portal : '.') + note],
    rejected: ['About your Mwakete seller application',
      'We could not approve "' + owner.StoreName + '" this time.' + note +
      '\n\nYou can fix what is needed and apply again from your Mwakete account.'],
    suspended: ['Your Mwakete store is suspended',
      '"' + owner.StoreName + '" is suspended and hidden from shoppers.' + note +
      '\n\nContact Mwakete via Help and support if you have questions.'],
    reinstated: ['Your Mwakete store is back',
      '"' + owner.StoreName + '" is active again' + (portal ? '. Log in: ' + portal : '.') + note]
  }[kind];
  if (!lines || !owner.Email) return;
  try { sendAppEmail(owner.Email, lines[0], lines[1]); } catch (e) { Logger.log('seller application email failed'); }

  if (kind !== 'received') return;
  var adminUrl = base ? base + '/owner/admin.html#seller-applications' : '';
  getAdminEmails().forEach(function (to) {
    try {
      sendAppEmail(to, 'New seller application - ' + owner.StoreName,
        'Store: ' + owner.StoreName + '\nType: ' + storeTypeOf(owner) + '\nEmail: ' + owner.Email +
        '\nPhone: ' + owner.Phone + '\n\nWhat they will sell:\n' + (owner.ApplicationNote || '(not given)') +
        (adminUrl ? '\n\nReview it: ' + adminUrl : ''));
    } catch (e) { Logger.log('seller application admin notify failed'); }
  });
}

function storeOfCustomer_(customerId) {
  var sheet = getSheet('Owners');
  return sheetToObjects(sheet).filter(function (o) { return String(o.CustomerId || '') === String(customerId); })[0] || null;
}

/** The shopper account page: "Become a Seller" status. body: { token } */
function actionGetSellerApplication(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Not signed in'); }
  var owner = storeOfCustomer_(customer.CustomerId);
  return ok({ application: owner ? sellerApplicationView(owner) : null, emailVerified: customerEmailVerified(customer) });
}

/** Admin: applications by status (default pending). body: { status } */
function actionAdminListSellerApplications(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var want = String((body && body.status) || 'pending');
  var rows = sheetToObjects(getSheet('Owners')).filter(function (o) {
    if (want === 'all') return !!o.AppliedAt || ownerApprovalStatus(o) !== 'approved';
    return ownerApprovalStatus(o) === want && (want !== 'approved' || !!o.AppliedAt);
  });
  rows.sort(function (a, b) { return String(b.AppliedAt || '').localeCompare(String(a.AppliedAt || '')); });
  return ok({ applications: rows.map(sellerApplicationAdminView) });
}

var SELLER_DECISIONS = {
  approve:   { from: ['pending', 'rejected'], to: 'approved', mail: 'approved', event: 'seller-approved' },
  reject:    { from: ['pending'], to: 'rejected', mail: 'rejected', event: 'seller-rejected' },
  suspend:   { from: ['approved'], to: 'suspended', mail: 'suspended', event: 'seller-suspended' },
  reinstate: { from: ['suspended'], to: 'approved', mail: 'reinstated', event: 'seller-reinstated' }
};

/** Admin: body { ownerId, decision: approve|reject|suspend|reinstate, note } */
function actionAdminReviewSellerApplication(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  body = body || {};
  var rule = SELLER_DECISIONS[String(body.decision || '')];
  if (!rule) return fail('Unknown decision');
  var note = String(body.note || '').trim();
  if (note.length > SELLER_REVIEW_NOTE_MAX) return fail('Keep the note under ' + SELLER_REVIEW_NOTE_MAX + ' characters');
  if ((body.decision === 'reject' || body.decision === 'suspend') && !note) {
    return fail('Write a short reason - the seller sees it in the email.');
  }

  var sheet = getSheet('Owners');
  ['ApprovalStatus', 'ReviewedAt', 'ReviewedBy', 'ReviewNote'].forEach(function (c) { ensureColumn(sheet, c); });
  var target;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    target = findRowById(sheet, 'OwnerId', String(body.ownerId || ''));
    if (!target) return fail('Store not found');
    if (target.OwnerId === owner.OwnerId || isOwnerAdmin(target)) {
      if (rule.to !== 'approved') return fail('An admin store cannot be ' + rule.to + ' here.');
    }
    var current = ownerApprovalStatus(target);
    if (rule.from.indexOf(current) === -1) return fail('This store is ' + current + ' - it cannot be ' + body.decision + 'd.');
    updateRowFromObject(sheet, target.__row, {
      ApprovalStatus: rule.to,
      ReviewedAt: nowIso(),
      ReviewedBy: owner.OwnerId,
      ReviewNote: sanitizeForSheetCell(note)
    });
    target = findRowById(sheet, 'OwnerId', target.OwnerId);
    if (rule.to === 'suspended') revokeAllSessions(target.OwnerId);
  } finally {
    lock.releaseLock();
  }
  logAuthEvent(rule.event, target.OwnerId, 'by ' + owner.OwnerId);
  notifySellerApplication(target, rule.mail);
  return ok({ application: sellerApplicationAdminView(target) });
}
