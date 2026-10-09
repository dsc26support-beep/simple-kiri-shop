/**
 * Listing review: the category register, the admin review queue and the audit
 * log around the rules in ListingRules.gs. (Owner request, Oct 2026.)
 *
 * THREE NEW TABS - created on first use, never rewritten:
 *   Categories            the register. Seeded once from LISTING_CATEGORY_SEED;
 *                         admins add subcategories, keywords and switch
 *                         categories on/off. Rows are never deleted.
 *   Product_Review_Queue  one row per case: a listing the checks stopped (or
 *                         warned about), or a seller's request for a new
 *                         category. Keeps a snapshot of what was submitted and
 *                         a HistoryJson of every status change.
 *   Audit_Log             append-only record of material actions.
 * Products gains four columns, added past the last header (ensureColumn):
 *   SubcategoryId, RequestedStatus, ReviewId, ReviewApprovedFingerprint.
 *
 * PRODUCT STATUS 'review' = held: saved, not shown to shoppers. Every public
 * read already filters Status === 'active', so a held listing is invisible
 * without touching those paths. RequestedStatus remembers what the seller
 * asked for (active/hidden), applied when the hold is lifted.
 *
 * WHO MAY DO WHAT is decided here on the server, never by the page:
 *   sellers  - save their own listings (checked every time), request a
 *              category, see their own cases without admin notes.
 *   admins   - an owner session whose email is in ADMIN_EMAILS (Admin.gs).
 *              Every admin action below calls isOwnerAdmin first.
 */

var LISTING_CATEGORY_HEADERS = ['CategoryId', 'CategoryName', 'ParentCategoryId', 'Description', 'Keywords', 'Synonyms',
  'PermittedProductTypes', 'RequiredAttributes', 'RecommendedAttributes', 'Kind', 'AlsoListedIn', 'Status',
  'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'];
var LISTING_QUEUE_HEADERS = ['ReviewId', 'CaseType', 'ProductId', 'SellerId', 'ProductNameSnapshot', 'DescriptionSnapshot',
  'SelectedCategoryId', 'SelectedSubcategoryId', 'SuggestedCategoryIds', 'IssueType', 'Severity', 'Reason',
  'ValidationRulesTriggered', 'ValidationJson', 'SellerDisputed', 'SellerNote', 'Status', 'SubmittedAt', 'ReviewedAt', 'ReviewedBy',
  'ResolutionType', 'ResolutionReason', 'FinalCategoryId', 'FinalSubcategoryId', 'ProposedCategoryName', 'ProposedParentId',
  'ExampleProducts', 'DuplicateOf', 'HistoryJson', 'Version', 'UpdatedAt'];
var LISTING_AUDIT_HEADERS = ['AuditId', 'Timestamp', 'ActorId', 'ActorRole', 'Action', 'EntityType', 'EntityId',
  'PreviousStateSummary', 'NewStateSummary', 'Reason', 'RequestId'];

var REVIEW_STATUSES = ['PENDING', 'IN_REVIEW', 'AWAITING_SELLER', 'APPROVED', 'CORRECTION_REQUIRED', 'REJECTED', 'DISMISSED', 'CLOSED'];
var REVIEW_OPEN_STATUSES = ['PENDING', 'IN_REVIEW', 'AWAITING_SELLER', 'CORRECTION_REQUIRED'];
var REVIEW_RESOLVED_STATUSES = ['APPROVED', 'REJECTED', 'DISMISSED', 'CLOSED'];

/**
 * The only status changes the backend accepts. Anything else is refused.
 *   open -> decided (APPROVED / REJECTED / DISMISSED), or CLOSED when the
 *           seller fixes the listing themselves;
 *   open <-> open   (claim, release, ask the seller, seller resubmits);
 *   decided -> CLOSED (final), or back to PENDING (reopen);
 *   CLOSED -> PENDING (reopen).
 */
var REVIEW_TRANSITIONS = {
  PENDING: ['IN_REVIEW', 'APPROVED', 'CORRECTION_REQUIRED', 'AWAITING_SELLER', 'REJECTED', 'DISMISSED', 'CLOSED'],
  IN_REVIEW: ['PENDING', 'APPROVED', 'CORRECTION_REQUIRED', 'AWAITING_SELLER', 'REJECTED', 'DISMISSED', 'CLOSED'],
  CORRECTION_REQUIRED: ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'DISMISSED', 'CLOSED'],
  AWAITING_SELLER: ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'DISMISSED', 'CLOSED'],
  APPROVED: ['CLOSED', 'PENDING'],
  REJECTED: ['CLOSED', 'PENDING'],
  DISMISSED: ['CLOSED', 'PENDING'],
  CLOSED: ['PENDING']
};

function reviewTransitionAllowed(from, to) {
  return !!(REVIEW_TRANSITIONS[from] && REVIEW_TRANSITIONS[from].indexOf(to) !== -1);
}

var LISTING_REGISTER_CACHE_KEY = 'v1:listingRegister';
var LISTING_REASON_MIN = 10;
var CATEGORY_REQUEST_OPEN_MAX = 5;
// Too broad to be a category on their own.
var CATEGORY_NAME_TOO_BROAD = ['stuff', 'things', 'other', 'others', 'misc', 'miscellaneous', 'general', 'products', 'items',
  'everything', 'all', 'goods', 'random', 'various', 'new', 'sale', 'shop'];

/* ==================== Sheets ==================== */

function getListingQueueSheet() {
  var sheet = getSheetCreating('Product_Review_Queue', LISTING_QUEUE_HEADERS);
  LISTING_QUEUE_HEADERS.forEach(function (h) { ensureColumn(sheet, h); });
  return sheet;
}
function getListingAuditSheet() { return getSheetCreating('Audit_Log', LISTING_AUDIT_HEADERS); }

/**
 * The Categories tab, created and seeded on first need. Seeding only appends
 * ids that are not there yet, so running it again (or after an admin added
 * rows) changes nothing that exists.
 */
function getCategoriesSheet(actorId) {
  var sheet = getSheetCreating('Categories', LISTING_CATEGORY_HEADERS);
  LISTING_CATEGORY_HEADERS.forEach(function (h) { ensureColumn(sheet, h); });
  var have = {};
  sheetToObjects(sheet).forEach(function (r) { have[String(r.CategoryId)] = true; });
  var now = nowIso();
  LISTING_CATEGORY_SEED.forEach(function (s) {
    if (have[s.id]) return;
    appendRowFromObject(sheet, {
      CategoryId: s.id, CategoryName: s.name, ParentCategoryId: s.parentId || '', Description: '',
      Keywords: s.keywords || '', Synonyms: '', PermittedProductTypes: (s.types || LISTING_ALL_TYPES).join(', '),
      RequiredAttributes: s.required || '', RecommendedAttributes: s.recommended || '', Kind: s.kind || '',
      AlsoListedIn: s.alsoIn || '', Status: 'active', CreatedAt: now, CreatedBy: actorId || 'setup', UpdatedAt: now, UpdatedBy: actorId || 'setup'
    });
  });
  return sheet;
}

/** Run once from the Apps Script editor (optional - everything also creates itself on first use). */
function setupListingReview() {
  getCategoriesSheet('setup');
  getListingQueueSheet();
  getListingAuditSheet();
  ['SubcategoryId', 'RequestedStatus', 'ReviewId', 'ReviewApprovedFingerprint'].forEach(function (h) { ensureColumn(getSheet('Products'), h); });
  var msg = 'Listing review ready: Categories, Product_Review_Queue, Audit_Log.';
  Logger.log(msg);
  return msg;
}

function categoryRowToRegister(r) {
  return {
    id: String(r.CategoryId || '').trim(), name: r.CategoryName, parentId: String(r.ParentCategoryId || '').trim(),
    kind: r.Kind, keywords: r.Keywords, synonyms: r.Synonyms, types: listingSplitList(r.PermittedProductTypes),
    required: r.RequiredAttributes, recommended: r.RecommendedAttributes, alsoIn: r.AlsoListedIn, status: r.Status
  };
}

/**
 * Register rows in engine shape. The sheet wins once it exists; before setup
 * the built-in seed is used, so listing checks work from the first deploy.
 * Cached 10 minutes; every admin change clears it (invalidateListingRegister).
 */
function listingRegisterRows() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(LISTING_REGISTER_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  var sheet = SpreadsheetApp.getActive().getSheetByName('Categories');
  var rows = sheet ? sheetToObjects(sheet).map(categoryRowToRegister).filter(function (r) { return !!r.id; }) : [];
  if (!rows.length) rows = LISTING_CATEGORY_SEED.map(function (s) { return s; });
  try { cache.put(LISTING_REGISTER_CACHE_KEY, JSON.stringify(rows), 600); } catch (e) { /* too big to cache - fine */ }
  return rows;
}

function invalidateListingRegister() { invalidateCache([LISTING_REGISTER_CACHE_KEY]); }

function getListingRegister() { return buildListingRegister(listingRegisterRows()); }

/* ==================== Audit ==================== */

function auditSummary(value) {
  if (value === undefined || value === null || value === '') return '';
  var s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 300 ? s.slice(0, 299) + '…' : s;
}

/**
 * Appends one audit row. Never throws - an audit write that fails must not
 * undo the action it records (it is logged instead). The same requestId +
 * action is written once, so a retried request is not recorded twice.
 */
function appendAudit(entry) {
  try {
    var rid = cleanRequestId(entry.requestId);
    if (rid) {
      var key = 'audit:' + rid + ':' + entry.action + ':' + (entry.entityId || '');
      var cache = CacheService.getScriptCache();
      if (cache.get(key)) return;
      cache.put(key, '1', 3600);
    }
    appendRowFromObject(getListingAuditSheet(), {
      AuditId: newId('aud'), Timestamp: nowIso(), ActorId: entry.actorId || '', ActorRole: entry.actorRole || '',
      Action: entry.action, EntityType: entry.entityType || '', EntityId: entry.entityId || '',
      PreviousStateSummary: auditSummary(entry.previous), NewStateSummary: auditSummary(entry.next),
      Reason: auditSummary(entry.reason), RequestId: rid || ''
    });
  } catch (err) {
    Logger.log('audit write failed: ' + (err && err.message));
  }
}

function cleanRequestId(value) {
  var s = String(value == null ? '' : value);
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : '';
}

/**
 * Retry safety for a write. The same requestId within 10 minutes gets the
 * first answer back instead of doing the work twice. Caller holds the lock,
 * so two copies of one request cannot both get past the check.
 */
function idempotentResult(scope, requestId, run) {
  var rid = cleanRequestId(requestId);
  if (!rid) return run();
  var cache = CacheService.getScriptCache();
  var key = 'idem:' + scope + ':' + rid;
  var hit = cache.get(key);
  if (hit) {
    try { var prior = JSON.parse(hit); prior.replayed = true; return prior; } catch (e) { /* run again */ }
  }
  var result = run();
  if (result && result.ok) {
    try { cache.put(key, JSON.stringify(result), 600); } catch (e) { /* large answer - not replayable */ }
  }
  return result;
}

function denyAdmin(owner, action, entityId) {
  appendAudit({ actorId: owner ? owner.OwnerId : '', actorRole: 'seller', action: 'UNAUTHORIZED_ATTEMPT', entityType: 'review',
    entityId: entityId || '', next: action });
  return fail('Not authorized');
}

/* ==================== Product save gate ==================== */

function listingFingerprint(input) {
  var text = listingFingerprintText(input);
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

/** Attribute values a seller sent, limited to known keys and short strings. */
function cleanListingAttributes(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(LISTING_ATTRIBUTES).forEach(function (k) {
    if (raw[k] === undefined || raw[k] === null) return;
    var v = String(raw[k]).trim().slice(0, 60);
    if (v) out[k] = v;
  });
  return out;
}

/**
 * Called by actionCreateOrUpdateProduct (Products.gs) before anything is
 * written. Returns either { stop: <fail response> } - nothing is saved - or
 * { mode, validation, ... } telling the save how to proceed:
 *   'publish'  normal save (status as the seller chose)
 *   'hold'     save with Status 'review' and open/refresh a blocking case
 *   'warn'     normal save, plus a non-blocking case for an admin to look at
 */
function listingSaveGate(owner, body, prior, input) {
  var register = getListingRegister();
  var allowInactive = prior ? [String(prior.Category || ''), String(prior.SubcategoryId || '')].filter(function (x) { return !!x; }) : [];
  input.allowInactive = allowInactive;
  input.keepType = !!(prior && categoryIdOf(prior.Category) === input.categoryId && listingTypeOfRow(prior) === input.listingType);
  var validation = validateListing(input, register);
  var fingerprint = listingFingerprint(input);
  var approved = !!(prior && prior.ReviewApprovedFingerprint && String(prior.ReviewApprovedFingerprint) === fingerprint);

  var respond = function (message, extra) {
    var out = fail(message);
    out.validation = validation;
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return out;
  };

  if (validation.blocked && !validation.overridable) {
    return { stop: respond(validation.issues.filter(function (i) { return i.blocking; })[0].message, { needsCorrection: true }) };
  }

  // An admin already cleared exactly this name, description and category.
  if (approved && (validation.blocked || validation.severity === 'medium')) {
    return { mode: 'publish', validation: validation, fingerprint: fingerprint, clearedByAdmin: true };
  }

  if (validation.blocked) {
    if (body.submitForReview !== true) {
      // Repeated blocked attempts are throttled, so the form can't be used to
      // probe for a category the checks happen not to cover.
      if (rateLimitHit('listingblock:' + owner.OwnerId, 30, 3600)) {
        return { stop: fail('Too many attempts to save listings that need checking. Please wait a few minutes, or submit this one for review.') };
      }
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'VALIDATION_FAILED', entityType: 'product',
        entityId: prior ? prior.ProductId : 'new', next: { rules: validation.rulesTriggered, name: listingQuote(input.name, 60), category: input.categoryId } });
      return { stop: respond(validation.issues.filter(function (i) { return i.blocking; })[0].message, { needsReview: true, canSubmitForReview: true }) };
    }
    return { mode: 'hold', validation: validation, fingerprint: fingerprint };
  }

  if (validation.severity === 'medium') {
    if (body.acknowledgeWarnings !== true && body.submitForReview !== true) {
      return { stop: respond(validation.issues.filter(function (i) { return i.severity === 'medium'; })[0].message, { canSaveAnyway: true }) };
    }
    return { mode: 'warn', validation: validation, fingerprint: fingerprint };
  }

  return { mode: 'publish', validation: validation, fingerprint: fingerprint };
}

function listingIssueType(validation) {
  var codes = validation.rulesTriggered.filter(function (c) { return c !== 'ATTRIBUTE_RECOMMENDED'; });
  return codes[0] || 'NONE';
}

function parseHistory(raw) {
  try { var h = JSON.parse(raw || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; }
}

function withHistory(caseRow, entry) {
  var h = parseHistory(caseRow.HistoryJson);
  entry.at = nowIso();
  h.push(entry);
  // Bounded so one busy case can't outgrow a cell (50,000 characters).
  while (JSON.stringify(h).length > 40000 && h.length > 1) h.splice(1, 1);
  return JSON.stringify(h);
}

function findOpenListingCase(queueRows, productId) {
  for (var i = queueRows.length - 1; i >= 0; i--) {
    var r = queueRows[i];
    if (r.CaseType === 'LISTING' && String(r.ProductId) === String(productId) && REVIEW_OPEN_STATUSES.indexOf(String(r.Status)) !== -1) return r;
  }
  return null;
}

/**
 * Opens a case for this product, or refreshes the open one - never a second
 * open case for the same product. Caller holds the script lock.
 */
function upsertListingCase(owner, productId, input, validation, opts) {
  var sheet = getListingQueueSheet();
  var rows = sheetToObjects(sheet);
  var existing = findOpenListingCase(rows, productId);
  var now = nowIso();
  var fields = {
    ProductNameSnapshot: String(input.name || '').slice(0, 150),
    DescriptionSnapshot: String(input.description || '').slice(0, 2000),
    SelectedCategoryId: input.categoryId || '',
    SelectedSubcategoryId: input.subcategoryId || '',
    SuggestedCategoryIds: validation.suggestions.map(function (s) { return s.subcategoryId || s.categoryId; }).join(', '),
    IssueType: listingIssueType(validation),
    Severity: validation.severity,
    Reason: validation.issues.filter(function (i) { return i.severity !== 'low'; }).map(function (i) { return i.message; }).join(' ').slice(0, 1000),
    ValidationRulesTriggered: validation.rulesTriggered.join(', '),
    ValidationJson: JSON.stringify({ severity: validation.severity, blocked: validation.blocked, issues: validation.issues, suggestions: validation.suggestions }).slice(0, 20000),
    SellerDisputed: opts.disputed ? 'true' : 'false',
    SellerNote: String(opts.sellerNote || '').slice(0, 500),
    UpdatedAt: now
  };
  if (existing) {
    var from = String(existing.Status);
    var to = (from === 'CORRECTION_REQUIRED' || from === 'AWAITING_SELLER') ? 'PENDING' : from;
    fields.Status = to;
    fields.Version = (Number(existing.Version) || 0) + 1;
    fields.HistoryJson = withHistory(existing, { by: owner.OwnerId, role: opts.role || 'seller', from: from, to: to, note: 'Listing resubmitted: ' + fields.ValidationRulesTriggered });
    updateRowFromObject(sheet, existing.__row, fields);
    appendAudit({ actorId: owner.OwnerId, actorRole: opts.role || 'seller', action: 'REVIEW_CASE_UPDATED', entityType: 'review', entityId: existing.ReviewId,
      previous: from, next: { status: to, rules: fields.ValidationRulesTriggered }, requestId: opts.requestId });
    return existing.ReviewId;
  }
  var reviewId = newId('rev');
  fields.ReviewId = reviewId;
  fields.CaseType = 'LISTING';
  fields.ProductId = productId;
  fields.SellerId = owner.OwnerId;
  fields.Status = 'PENDING';
  fields.SubmittedAt = now;
  fields.Version = 1;
  fields.HistoryJson = JSON.stringify([{ at: now, by: owner.OwnerId, role: opts.role || 'seller', from: '', to: 'PENDING', note: opts.disputed ? 'Seller submitted for review' : 'Saved with a warning' }]);
  appendRowFromObject(sheet, fields);
  appendAudit({ actorId: owner.OwnerId, actorRole: opts.role || 'seller', action: 'REVIEW_CASE_CREATED', entityType: 'review', entityId: reviewId,
    next: { productId: productId, severity: validation.severity, rules: fields.ValidationRulesTriggered }, requestId: opts.requestId });
  maybeNotifyAdminsOfCase(reviewId, fields);
  return reviewId;
}

/** A seller fixed the listing: close whatever case was open on it. Caller holds the lock. */
function closeListingCaseAsCorrected(owner, productId, requestId) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  if (!sheet) return null;
  var open = findOpenListingCase(sheetToObjects(sheet), productId);
  if (!open) return null;
  updateRowFromObject(sheet, open.__row, {
    Status: 'CLOSED', ResolutionType: 'SELLER_CORRECTED', ResolutionReason: 'The seller corrected the listing and it passed the checks.',
    ReviewedAt: nowIso(), ReviewedBy: 'system', Version: (Number(open.Version) || 0) + 1, UpdatedAt: nowIso(),
    HistoryJson: withHistory(open, { by: owner.OwnerId, role: 'seller', from: String(open.Status), to: 'CLOSED', note: 'Corrected by the seller' })
  });
  appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'SELLER_CORRECTION', entityType: 'review', entityId: open.ReviewId,
    previous: String(open.Status), next: 'CLOSED', requestId: requestId });
  return open.ReviewId;
}

/** Opt-in: Script Property LISTING_REVIEW_NOTIFY = true emails ADMIN_EMAILS about each new case. */
function maybeNotifyAdminsOfCase(reviewId, fields) {
  try {
    if (String(PropertiesService.getScriptProperties().getProperty('LISTING_REVIEW_NOTIFY') || '') !== 'true') return;
    var admins = getAdminEmails();
    var url = siteBaseUrl() ? siteBaseUrl() + '/owner/admin.html#listing-review' : '';
    admins.forEach(function (to) {
      sendAppEmail(to, 'Listing to review: ' + String(fields.ProductNameSnapshot || fields.ProposedCategoryName || reviewId).slice(0, 60),
        'A ' + (fields.Severity || '') + ' case is waiting in the review queue.\n\n' + String(fields.Reason || '').slice(0, 500) + (url ? '\n\nOpen the queue: ' + url : ''));
    });
  } catch (e) { Logger.log('review notify failed: ' + (e && e.message)); }
}

/** Best effort: a seller hears about a decision on their listing or request. */
function notifySellerOfCase(sellerId, subject, message) {
  try {
    var owner = findRowById(getSheet('Owners'), 'OwnerId', sellerId);
    if (!owner || !owner.Email) return;
    var url = siteBaseUrl() ? siteBaseUrl() + '/owner/products.html' : '';
    sendAppEmail(owner.Email, subject, message + (url ? '\n\nYour products: ' + url : '') + '\n\nMwakete');
  } catch (e) { Logger.log('seller review notify failed: ' + (e && e.message)); }
}

/* ==================== Public: the register ==================== */

/** GET listCategories - the register for the seller form (no ids of people, nothing private). */
function actionListCategories() {
  var rows = listingRegisterRows();
  return ok({
    categories: rows.map(function (r) {
      return { id: r.id, name: r.name, parentId: r.parentId || '', kind: r.kind || '', keywords: r.keywords || '', synonyms: r.synonyms || '',
        types: listingSplitList(r.types && r.types.length ? r.types : LISTING_ALL_TYPES), required: r.required || '', recommended: r.recommended || '',
        alsoIn: r.alsoIn || '', status: String(r.status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active' };
    })
  });
}

/* ==================== Seller: category requests and own cases ==================== */

function categoryNameError(name) {
  var n = String(name || '').replace(/\s+/g, ' ').trim();
  if (n.length < 3 || n.length > 40) return 'A category name needs 3 to 40 characters.';
  if (!/^[A-Za-z0-9&',() \-]+$/.test(n)) return 'Use letters, numbers, spaces and & \' - ( ) only.';
  if (CATEGORY_NAME_TOO_BROAD.indexOf(listingNormalize(n)) !== -1) return 'That name is too broad to be a category. Say what the products are.';
  return '';
}

/** The existing category (active or not) a proposed name duplicates, if any. */
function duplicateCategoryOf(register, name) {
  var target = listingTokens(name).join(' ');
  if (!target) return null;
  for (var i = 0; i < register.list.length; i++) {
    var row = register.list[i];
    if (listingTokens(row.name).join(' ') === target) return row;
    for (var k = 0; k < row.keywords.length; k++) {
      if (listingTokens(row.keywords[k].replace(/^~/, '')).join(' ') === target) return row;
    }
  }
  return null;
}

function actionRequestCategory(owner, body) {
  var name = String(body.proposedName || '').replace(/\s+/g, ' ').trim();
  var nameErr = categoryNameError(name);
  if (nameErr) return fail(nameErr);
  var explanation = String(body.explanation || '').trim();
  if (explanation.length < 10) return fail('Please explain in a sentence what would go in this category.');
  var examples = String(body.examples || '').trim();
  if (examples.length < 3) return fail('Please give one or two example products.');
  var lenErr = capLength(explanation, 500, 'Explanation') || capLength(examples, 300, 'Example products');
  if (lenErr) return lenErr;
  var register = getListingRegister();
  var parentId = String(body.parentId || '').trim();
  if (parentId) {
    var parent = register.byId[parentId];
    if (!parent || parent.parentId || !parent.active) return fail('Choose the parent category from the list, or leave it blank.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return idempotentResult('catreq:' + owner.OwnerId, body.requestId, function () {
      var sheet = getListingQueueSheet();
      var rows = sheetToObjects(sheet);
      var mine = rows.filter(function (r) { return r.CaseType === 'CATEGORY_REQUEST' && r.SellerId === owner.OwnerId && REVIEW_OPEN_STATUSES.indexOf(String(r.Status)) !== -1; });
      if (mine.length >= CATEGORY_REQUEST_OPEN_MAX) return fail('You already have ' + CATEGORY_REQUEST_OPEN_MAX + ' category requests waiting. Please wait for an answer first.');
      var dup = duplicateCategoryOf(register, name);
      var normal = listingTokens(name).join(' ');
      var dupRequest = rows.filter(function (r) {
        return r.CaseType === 'CATEGORY_REQUEST' && REVIEW_OPEN_STATUSES.indexOf(String(r.Status)) !== -1 && listingTokens(r.ProposedCategoryName).join(' ') === normal;
      })[0];
      var duplicateOf = dup ? dup.id : (dupRequest ? dupRequest.ReviewId : '');
      var now = nowIso();
      var reviewId = newId('rev');
      var fields = {
        ReviewId: reviewId, CaseType: 'CATEGORY_REQUEST', ProductId: String(body.productId || '').slice(0, 60), SellerId: owner.OwnerId,
        IssueType: duplicateOf ? 'CATEGORY_REQUEST_DUPLICATE' : 'CATEGORY_REQUEST', Severity: duplicateOf ? 'low' : 'medium',
        Reason: duplicateOf ? 'Possible duplicate of ' + (dup ? listingCategoryPath(register, dup.id) : 'another open request (' + duplicateOf + ')') : 'New category requested',
        ProposedCategoryName: name, ProposedParentId: parentId, ExampleProducts: examples, SellerNote: explanation, DuplicateOf: duplicateOf,
        Status: 'PENDING', SubmittedAt: now, UpdatedAt: now, Version: 1, SellerDisputed: 'false',
        HistoryJson: JSON.stringify([{ at: now, by: owner.OwnerId, role: 'seller', from: '', to: 'PENDING', note: 'Category requested' }])
      };
      appendRowFromObject(sheet, fields);
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'CATEGORY_REQUESTED', entityType: 'review', entityId: reviewId,
        next: { name: name, parentId: parentId, duplicateOf: duplicateOf }, requestId: body.requestId });
      maybeNotifyAdminsOfCase(reviewId, fields);
      return ok({ reviewId: reviewId, duplicateOf: duplicateOf,
        message: dup ? 'Sent. It looks close to ' + listingCategoryPath(register, dup.id) + ' - you can use that one meanwhile.' : 'Sent. An admin will look at it.' });
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * What the seller hears about their cases. The admin's reason is shown only
 * where it was written FOR the seller (a correction request or a rejection) -
 * override and dismiss reasons are internal.
 */
function sellerCaseView(r, register) {
  var status = String(r.Status);
  var forSeller = ['CORRECTION_REQUIRED', 'AWAITING_SELLER', 'REJECTED'].indexOf(status) !== -1 ||
    (r.CaseType === 'CATEGORY_REQUEST' && ['APPROVED', 'CLOSED'].indexOf(status) !== -1);
  return {
    reviewId: r.ReviewId, caseType: r.CaseType, productId: r.ProductId, productName: r.ProductNameSnapshot,
    proposedCategoryName: r.ProposedCategoryName, status: status, severity: r.Severity,
    reason: r.CaseType === 'LISTING' ? r.Reason : '',
    adminMessage: forSeller ? String(r.ResolutionReason || '') : '',
    finalCategoryPath: r.FinalSubcategoryId || r.FinalCategoryId ? listingCategoryPath(register, r.FinalSubcategoryId || r.FinalCategoryId) : '',
    submittedAt: r.SubmittedAt, updatedAt: r.UpdatedAt
  };
}

function actionListMyReviewCases(owner) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  if (!sheet) return ok({ cases: [] });
  var register = getListingRegister();
  var mine = sheetToObjects(sheet).filter(function (r) { return r.SellerId === owner.OwnerId; })
    .sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); })
    .slice(0, 50);
  return ok({ cases: mine.map(function (r) { return sellerCaseView(r, register); }) });
}

/** {productId: seller view of its latest case} for the seller's product list. */
function latestCaseByProduct(ownerId) {
  var out = {};
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  if (!sheet) return out;
  var register = getListingRegister();
  sheetToObjects(sheet).forEach(function (r) {
    if (r.CaseType !== 'LISTING' || r.SellerId !== ownerId) return;
    out[r.ProductId] = sellerCaseView(r, register);
  });
  return out;
}

/* ==================== Admin: queue ==================== */

function adminCaseSummary(r, storeNames, register) {
  return {
    reviewId: r.ReviewId, caseType: r.CaseType, productId: r.ProductId, sellerId: r.SellerId, storeName: storeNames[r.SellerId] || '',
    productName: r.ProductNameSnapshot, proposedCategoryName: r.ProposedCategoryName,
    categoryPath: listingCategoryPath(register, r.SelectedSubcategoryId || r.SelectedCategoryId),
    issueType: r.IssueType, severity: r.Severity, status: r.Status, disputed: String(r.SellerDisputed) === 'true',
    reason: String(r.Reason || '').slice(0, 300), submittedAt: r.SubmittedAt, updatedAt: r.UpdatedAt, version: Number(r.Version) || 0
  };
}

function reviewMetrics(rows, periodDays) {
  var since = Date.now() - periodDays * 86400000;
  var m = { pending: 0, highPriority: 0, categoryRequests: 0, disputed: 0, resolvedInPeriod: 0, periodDays: periodDays };
  rows.forEach(function (r) {
    var open = REVIEW_OPEN_STATUSES.indexOf(String(r.Status)) !== -1;
    if (open) {
      m.pending++;
      if (r.Severity === 'high') m.highPriority++;
      if (r.CaseType === 'CATEGORY_REQUEST') m.categoryRequests++;
      if (String(r.SellerDisputed) === 'true') m.disputed++;
    } else if (r.ReviewedAt && new Date(r.ReviewedAt).getTime() >= since) {
      m.resolvedInPeriod++;
    }
  });
  return m;
}

/**
 * The queue, filtered and paged on the server; only one page is returned.
 * Filters: status ('open' | 'resolved' | 'all' | one status), severity,
 * issueType, categoryId, sellerId, from / to (YYYY-MM-DD, submitted date),
 * q (product name, product id or review id).
 */
function actionListReviewCases(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'listReviewCases');
  body = body || {};
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  var rows = sheet ? sheetToObjects(sheet) : [];
  var register = getListingRegister();
  var periodDays = Math.min(365, Math.max(1, Number(body.periodDays) || 30));
  var metrics = reviewMetrics(rows, periodDays);

  var status = String(body.status || 'open');
  var severity = String(body.severity || '');
  var issueType = String(body.issueType || '');
  var categoryId = String(body.categoryId || '');
  var sellerId = String(body.sellerId || '');
  var from = /^\d{4}-\d{2}-\d{2}$/.test(String(body.from || '')) ? String(body.from) : '';
  var to = /^\d{4}-\d{2}-\d{2}$/.test(String(body.to || '')) ? String(body.to) : '';
  var q = listingNormalize(String(body.q || '').slice(0, 100));

  var list = rows.filter(function (r) {
    var s = String(r.Status);
    if (status === 'open' && REVIEW_OPEN_STATUSES.indexOf(s) === -1) return false;
    if (status === 'resolved' && REVIEW_RESOLVED_STATUSES.indexOf(s) === -1) return false;
    if (REVIEW_STATUSES.indexOf(status) !== -1 && s !== status) return false;
    if (severity && r.Severity !== severity) return false;
    if (issueType && r.IssueType !== issueType && r.CaseType !== issueType) return false;
    if (categoryId && r.SelectedCategoryId !== categoryId && r.SelectedSubcategoryId !== categoryId && r.ProposedParentId !== categoryId) return false;
    if (sellerId && r.SellerId !== sellerId) return false;
    var day = String(r.SubmittedAt || '').slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (q) {
      var hay = listingNormalize([r.ProductNameSnapshot, r.ProposedCategoryName, r.ProductId, r.ReviewId].join(' '));
      if (hay.indexOf(q) === -1 && String(r.ProductId) !== String(body.q) && String(r.ReviewId) !== String(body.q)) return false;
    }
    return true;
  });
  // High first, then oldest first: the longest-waiting serious case on top.
  var sevRank = { high: 0, medium: 1, low: 2 };
  list.sort(function (a, b) {
    var d = (sevRank[a.Severity] === undefined ? 3 : sevRank[a.Severity]) - (sevRank[b.Severity] === undefined ? 3 : sevRank[b.Severity]);
    return d || String(a.SubmittedAt).localeCompare(String(b.SubmittedAt));
  });
  var pageSize = clampPageSize(body.pageSize, 20, 50);
  var page = Math.max(0, Math.floor(Number(body.page) || 0));
  var slice = list.slice(page * pageSize, page * pageSize + pageSize);

  var storeNames = {};
  var wanted = {};
  slice.forEach(function (r) { wanted[r.SellerId] = true; });
  sheetToObjects(getSheet('Owners')).forEach(function (o) { if (wanted[o.OwnerId]) storeNames[o.OwnerId] = o.StoreName; });

  return ok({
    metrics: metrics,
    cases: slice.map(function (r) { return adminCaseSummary(r, storeNames, register); }),
    total: list.length, page: page, pageSize: pageSize, hasMore: (page + 1) * pageSize < list.length
  });
}

function productListingInput(p, variants) {
  return {
    name: p.Name, description: p.Description, categoryId: categoryIdOf(p.Category), subcategoryId: String(p.SubcategoryId || ''),
    listingType: listingTypeOfRow(p), optionLabels: (variants || []).map(function (v) { return v.Label; }),
    allowInactive: [String(p.Category || ''), String(p.SubcategoryId || '')],
    keepType: true
  };
}

function activeVariantsOf(productId) {
  return sheetToObjects(getSheet('Variants')).filter(function (v) { return v.ProductId === productId && v.Status === 'active'; });
}

/** One case in full, with the product as it is now and a fresh run of the checks. */
function actionGetReviewCase(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'getReviewCase', body && body.reviewId);
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  var r = sheet ? findRowById(sheet, 'ReviewId', String(body.reviewId || '')) : null;
  if (!r) return fail('Case not found');
  var register = getListingRegister();
  var seller = findRowById(getSheet('Owners'), 'OwnerId', r.SellerId);
  var storeNames = {};
  if (seller) storeNames[seller.OwnerId] = seller.StoreName;
  var out = adminCaseSummary(r, storeNames, register);
  out.descriptionSnapshot = r.DescriptionSnapshot;
  out.selectedCategoryId = r.SelectedCategoryId;
  out.selectedSubcategoryId = r.SelectedSubcategoryId;
  out.suggestedCategoryIds = listingSplitList(r.SuggestedCategoryIds);
  out.suggestions = out.suggestedCategoryIds.map(function (id) { return { id: id, path: listingCategoryPath(register, id) }; });
  out.rules = listingSplitList(r.ValidationRulesTriggered);
  try { out.validationAtSubmit = JSON.parse(r.ValidationJson || 'null'); } catch (e) { out.validationAtSubmit = null; }
  out.sellerNote = r.SellerNote;
  out.examples = r.ExampleProducts;
  out.proposedParentId = r.ProposedParentId;
  out.proposedParentPath = r.ProposedParentId ? listingCategoryPath(register, r.ProposedParentId) : '';
  out.duplicateOf = r.DuplicateOf;
  out.duplicatePath = r.DuplicateOf && register.byId[r.DuplicateOf] ? listingCategoryPath(register, r.DuplicateOf) : '';
  out.resolutionType = r.ResolutionType;
  out.resolutionReason = r.ResolutionReason;
  out.reviewedAt = r.ReviewedAt;
  out.reviewedBy = r.ReviewedBy;
  out.history = parseHistory(r.HistoryJson);

  if (r.CaseType === 'LISTING' && r.ProductId) {
    var p = findRowById(getSheet('Products'), 'ProductId', r.ProductId);
    if (p) {
      var variants = activeVariantsOf(p.ProductId);
      out.product = {
        productId: p.ProductId, name: p.Name, description: p.Description, status: p.Status, requestedStatus: p.RequestedStatus || '',
        categoryId: categoryIdOf(p.Category), subcategoryId: String(p.SubcategoryId || ''),
        categoryPath: listingCategoryPath(register, String(p.SubcategoryId || '') || categoryIdOf(p.Category)),
        listingType: listingTypeOfRow(p), imageUrl: p.ImageUrl,
        variants: variants.map(function (v) { return { label: v.Label, price: Number(v.Price) }; })
      };
      out.currentValidation = validateListing(productListingInput(p, variants), register);
    }
    out.otherCases = sheetToObjects(sheet).filter(function (o) { return o.ProductId === r.ProductId && o.ReviewId !== r.ReviewId; })
      .map(function (o) { return { reviewId: o.ReviewId, status: o.Status, issueType: o.IssueType, submittedAt: o.SubmittedAt, resolutionType: o.ResolutionType }; });
  }
  return ok({ case: out });
}

/* ==================== Admin: actions on a case ==================== */

function publishHeldProduct(p, extra) {
  var sheet = getSheet('Products');
  var update = { UpdatedAt: nowIso() };
  if (String(p.Status) === 'review') update.Status = (p.RequestedStatus === 'hidden') ? 'hidden' : 'active';
  Object.keys(extra || {}).forEach(function (k) { update[k] = extra[k]; });
  updateRowFromObject(sheet, p.__row, update);
  var owner = findRowById(getSheet('Owners'), 'OwnerId', p.OwnerId);
  if (owner) invalidateCache([storeProductsCacheKey(owner.StoreSlug), storeListCacheKey(), topProductsCacheKey()]);
}

function hideProduct(p, status) {
  updateRowFromObject(getSheet('Products'), p.__row, { Status: status, UpdatedAt: nowIso() });
  var owner = findRowById(getSheet('Owners'), 'OwnerId', p.OwnerId);
  if (owner) invalidateCache([storeProductsCacheKey(owner.StoreSlug), storeListCacheKey(), topProductsCacheKey()]);
}

// Where each action takes a case (assignCategory may stay IN_REVIEW if the
// listing still fails after the change).
var REVIEW_ACTION_TARGET = {
  start: 'IN_REVIEW', release: 'PENDING', approve: 'APPROVED', assignCategory: 'APPROVED', override: 'APPROVED', dismiss: 'DISMISSED',
  requestCorrection: 'CORRECTION_REQUIRED', reject: 'REJECTED', close: 'CLOSED', reopen: 'PENDING', approveCategory: 'APPROVED', mergeCategory: 'APPROVED'
};

var REVIEW_ACTIONS = ['start', 'release', 'approve', 'assignCategory', 'override', 'dismiss', 'requestCorrection', 'reject', 'close', 'reopen',
  'approveCategory', 'mergeCategory'];

/**
 * Every admin decision goes through here. Sends the case's version as
 * expectedVersion: if someone else changed the case since it was opened the
 * action is refused, rather than one admin silently overwriting the other.
 */
function actionReviewCaseAction(owner, body) {
  body = body || {};
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'reviewCaseAction:' + String(body.action || ''), body.reviewId);
  // `action` is the API route ('reviewCaseAction'); the decision is its own field.
  var act = String(body.decision || '');
  if (REVIEW_ACTIONS.indexOf(act) === -1) return fail('Unknown review action');
  var reason = String(body.reason || '').replace(/\s+/g, ' ').trim();
  var reasonErr = capLength(reason, 1000, 'Reason');
  if (reasonErr) return reasonErr;
  var needsReason = ['override', 'dismiss', 'requestCorrection', 'reject', 'reopen'];
  if (needsReason.indexOf(act) !== -1 && reason.length < LISTING_REASON_MIN) {
    return fail('Please give a reason (at least ' + LISTING_REASON_MIN + ' characters). It is kept in the audit log.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return idempotentResult('review:' + owner.OwnerId, body.requestId, function () {
      var sheet = getListingQueueSheet();
      var r = findRowById(sheet, 'ReviewId', String(body.reviewId || ''));
      if (!r) return fail('Case not found');
      if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== (Number(r.Version) || 0)) {
        var stale = fail('This case was changed by someone else since you opened it. Reload it and try again.');
        stale.conflict = true;
        return stale;
      }
      return applyReviewDecision(owner, r, act, reason, body);
    });
  } finally {
    lock.releaseLock();
  }
}

/** The decision itself. Caller holds the lock and has checked admin + version. */
function applyReviewDecision(owner, r, act, reason, body) {
  var sheet = getListingQueueSheet();
  var register = getListingRegister();
  var from = String(r.Status);
  var isListing = r.CaseType === 'LISTING';
  var p = isListing && r.ProductId ? findRowById(getSheet('Products'), 'ProductId', r.ProductId) : null;
  if (isListing && !p && ['approve', 'assignCategory', 'override', 'dismiss'].indexOf(act) !== -1) return fail('The product for this case no longer exists.');
  if (!isListing && ['approve', 'assignCategory', 'override', 'dismiss', 'requestCorrection'].indexOf(act) !== -1) return fail('That action is for listing cases.');
  if (isListing && (act === 'approveCategory' || act === 'mergeCategory')) return fail('That action is for category requests.');

  var to;
  var update = {};
  var message = '';
  var sellerSubject = '', sellerMessage = '';
  var auditAction = 'REVIEW_' + act.toUpperCase();
  var extraOut = {};

  // Checked BEFORE anything is written: a refused transition must leave the
  // product exactly as it was.
  var intended = REVIEW_ACTION_TARGET[act];
  var movable = function (target) { return reviewTransitionAllowed(from, target) || (act === 'assignCategory' && target === 'IN_REVIEW' && from === 'IN_REVIEW'); };
  if (!movable(intended) && !(act === 'assignCategory' && movable('IN_REVIEW'))) {
    return fail('A ' + from.replace(/_/g, ' ').toLowerCase() + ' case cannot be moved to ' + intended.replace(/_/g, ' ').toLowerCase() + '.');
  }

  var current = function () { var v = activeVariantsOf(p.ProductId); return validateListing(productListingInput(p, v), register); };
  var fingerprintNow = function () { return listingFingerprint(productListingInput(p, activeVariantsOf(p.ProductId))); };

  switch (act) {
    case 'start': to = 'IN_REVIEW'; break;
    case 'release': to = 'PENDING'; break;
    case 'close':
      if (REVIEW_RESOLVED_STATUSES.indexOf(from) === -1 || from === 'CLOSED') return fail('Only a decided case can be closed. Approve, reject or dismiss it first.');
      to = 'CLOSED';
      break;
    case 'reopen': {
      to = 'PENDING';
      if (REVIEW_RESOLVED_STATUSES.indexOf(from) === -1) return fail('This case is already open.');
      if (isListing && p) {
        var vr = current();
        if (vr.blocked && String(p.Status) === 'active') {
          hideProduct(p, 'review');
          updateRowFromObject(getSheet('Products'), p.__row, { RequestedStatus: 'active', ReviewApprovedFingerprint: '' });
          extraOut.heldAgain = true;
        } else {
          updateRowFromObject(getSheet('Products'), p.__row, { ReviewApprovedFingerprint: '' });
        }
        update.ValidationJson = JSON.stringify({ severity: vr.severity, blocked: vr.blocked, issues: vr.issues, suggestions: vr.suggestions }).slice(0, 20000);
        update.ValidationRulesTriggered = vr.rulesTriggered.join(', ');
      }
      update.ResolutionType = '';
      break;
    }
    case 'approve': {
      var v = current();
      if (v.blocked) {
        var refused = fail('This listing still fails a check: ' + v.issues.filter(function (i) { return i.blocking; }).map(function (i) { return i.message; }).join(' ') +
          ' Assign the right category, ask the seller to correct it, or use Override with a reason.');
        refused.validation = v;
        return refused;
      }
      to = 'APPROVED';
      update.ResolutionType = 'APPROVED';
      update.FinalCategoryId = categoryIdOf(p.Category);
      update.FinalSubcategoryId = String(p.SubcategoryId || '');
      publishHeldProduct(p, { ReviewApprovedFingerprint: fingerprintNow(), ReviewId: r.ReviewId });
      sellerSubject = 'Your listing is approved';
      sellerMessage = 'Your listing "' + p.Name + '" has been checked and is now live.';
      break;
    }
    case 'assignCategory': {
      var catId = String(body.categoryId || '').trim();
      var subId = String(body.subcategoryId || '').trim();
      var cat = register.byId[catId];
      if (!cat || cat.parentId || !cat.active) return fail('Choose an active category.');
      if (subId) {
        var sub = register.byId[subId];
        if (!sub || sub.parentId !== catId || !sub.active) return fail('That subcategory is not active under ' + cat.name + '.');
      }
      var productsSheet = getSheet('Products');
      ensureColumn(productsSheet, 'SubcategoryId');
      updateRowFromObject(productsSheet, p.__row, { Category: catId, SubcategoryId: subId, UpdatedAt: nowIso() });
      p = findRowById(productsSheet, 'ProductId', p.ProductId);
      var va = current();
      update.FinalCategoryId = catId;
      update.FinalSubcategoryId = subId;
      auditAction = 'ADMIN_CATEGORY_CHANGE';
      if (va.blocked) {
        // Category changed, but the listing still fails (e.g. the name and
        // description disagree). It stays held; the case stays with the admin.
        to = 'IN_REVIEW';
        extraOut.stillBlocked = true;
        extraOut.validation = va;
        message = 'Category changed, but the listing still fails a check, so it stays hidden: ' +
          va.issues.filter(function (i) { return i.blocking; }).map(function (i) { return i.message; }).join(' ');
      } else {
        to = 'APPROVED';
        update.ResolutionType = 'CATEGORY_ASSIGNED';
        publishHeldProduct(p, { ReviewApprovedFingerprint: fingerprintNow(), ReviewId: r.ReviewId });
        sellerSubject = 'Your listing is live in a new category';
        sellerMessage = 'An admin moved "' + p.Name + '" to ' + listingCategoryPath(register, subId || catId) + '. It is now live.';
      }
      break;
    }
    case 'override':
    case 'dismiss': {
      var vo = current();
      if (!vo.overridable) {
        var hard = fail('This cannot be overridden: ' + vo.issues.filter(function (i) { return i.blocking; }).map(function (i) { return i.message; }).join(' ') + ' Ask the seller to correct it.');
        hard.validation = vo;
        return hard;
      }
      to = act === 'override' ? 'APPROVED' : 'DISMISSED';
      update.ResolutionType = act === 'override' ? 'OVERRIDE' : 'FALSE_POSITIVE';
      update.FinalCategoryId = categoryIdOf(p.Category);
      update.FinalSubcategoryId = String(p.SubcategoryId || '');
      // Clears THIS listing as it stands now. Any later change to its name,
      // description or category is checked again from scratch.
      publishHeldProduct(p, { ReviewApprovedFingerprint: fingerprintNow(), ReviewId: r.ReviewId });
      auditAction = act === 'override' ? 'OVERRIDE' : 'DISMISSED_FALSE_POSITIVE';
      sellerSubject = 'Your listing is live';
      sellerMessage = 'Your listing "' + p.Name + '" has been reviewed and is now live.';
      break;
    }
    case 'requestCorrection':
      to = 'CORRECTION_REQUIRED';
      sellerSubject = 'Please correct your listing';
      sellerMessage = 'An admin looked at "' + (p ? p.Name : r.ProductNameSnapshot) + '" and asks you to correct it:\n\n' + reason +
        '\n\nEdit the listing on your Products page and save it. It is checked again straight away.';
      break;
    case 'reject':
      to = 'REJECTED';
      if (isListing && p && String(p.Status) !== 'archived') hideProduct(p, 'hidden');
      sellerSubject = isListing ? 'Your listing was not approved' : 'Your category request';
      sellerMessage = isListing
        ? 'Your listing "' + (p ? p.Name : r.ProductNameSnapshot) + '" was not approved and is hidden:\n\n' + reason
        : 'Your request for a "' + r.ProposedCategoryName + '" category was not approved:\n\n' + reason;
      auditAction = isListing ? 'REVIEW_REJECT' : 'CATEGORY_REJECTED';
      break;
    case 'approveCategory': {
      var created = createCategoryFromRequest(owner, r, body, register);
      if (!created.ok) return created;
      to = 'APPROVED';
      update.ResolutionType = 'CATEGORY_CREATED';
      update.FinalCategoryId = created.parentId;
      update.FinalSubcategoryId = created.categoryId;
      extraOut.categoryId = created.categoryId;
      auditAction = 'CATEGORY_APPROVED';
      reason = reason || 'Approved as ' + created.path;
      sellerSubject = 'Your new category is ready';
      sellerMessage = 'Your request was approved. You can now choose ' + created.path + ' for your listings.';
      register = getListingRegister();
      extraOut.revalidated = revalidateHeldProducts(register);
      break;
    }
    case 'mergeCategory': {
      var target = register.byId[String(body.categoryId || '')];
      if (!target || !target.active) return fail('Choose an active category to merge this request into.');
      to = 'APPROVED';
      update.ResolutionType = 'MERGED';
      update.FinalCategoryId = target.parentId || target.id;
      update.FinalSubcategoryId = target.parentId ? target.id : '';
      auditAction = 'CATEGORY_MERGED';
      reason = reason || 'Use ' + listingCategoryPath(register, target.id);
      sellerSubject = 'Your category request';
      sellerMessage = 'Thanks for your request. Please use ' + listingCategoryPath(register, target.id) + ' for these products' +
        (body.reason ? ':\n\n' + body.reason : '.');
      break;
    }
  }

  if (!movable(to)) return fail('A ' + from.replace(/_/g, ' ').toLowerCase() + ' case cannot be moved to ' + to.replace(/_/g, ' ').toLowerCase() + '.');

  var now = nowIso();
  update.Status = to;
  update.Version = (Number(r.Version) || 0) + 1;
  update.UpdatedAt = now;
  if (REVIEW_RESOLVED_STATUSES.indexOf(to) !== -1 || to === 'CORRECTION_REQUIRED') {
    update.ReviewedAt = now;
    update.ReviewedBy = owner.OwnerId;
  }
  if (reason && act !== 'start' && act !== 'release') update.ResolutionReason = reason;
  update.HistoryJson = withHistory(r, { by: owner.OwnerId, role: 'admin', from: from, to: to, action: act, note: reason.slice(0, 300) });
  updateRowFromObject(sheet, r.__row, update);
  appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: auditAction, entityType: isListing ? 'product' : 'category-request',
    entityId: isListing ? r.ProductId + ' / ' + r.ReviewId : r.ReviewId, previous: from,
    next: { status: to, category: update.FinalSubcategoryId || update.FinalCategoryId || '' }, reason: reason, requestId: body.requestId });
  if (sellerSubject && act !== 'close') notifySellerOfCase(r.SellerId, sellerSubject, sellerMessage);

  var res = ok({ status: to, version: update.Version, message: message });
  Object.keys(extraOut).forEach(function (k) { res[k] = extraOut[k]; });
  return res;
}

/**
 * Adds an approved category to the register. Caller holds the lock.
 * Subcategories only: a new top-level category would also need a browse page
 * and a home-page button (helpers.js CATEGORIES), which is a code change.
 */
function createCategoryFromRequest(owner, r, body, register) {
  var name = String(body.name || r.ProposedCategoryName || '').replace(/\s+/g, ' ').trim();
  var nameErr = categoryNameError(name);
  if (nameErr) return fail(nameErr);
  var parentId = String(body.parentId || r.ProposedParentId || '').trim();
  var parent = register.byId[parentId];
  if (!parent || parent.parentId || !parent.active) return fail('Choose the parent category it belongs under.');
  var dup = duplicateCategoryOf(register, name);
  if (dup) return fail('That is the same as ' + listingCategoryPath(register, dup.id) + '. Merge the request into it instead.');
  var keywords = String(body.keywords || '').trim();
  var kwErr = capLength(keywords, 500, 'Keywords');
  if (kwErr) return kwErr;
  var kind = String(body.kind || '').trim();
  if (kind && !/^[a-z][a-z0-9-]{1,30}$/.test(kind)) return fail('Kind is lower-case letters and dashes, e.g. baby-goods.');
  var id = parentId + '-' + slugify(name).slice(0, 30);
  var n = 2;
  while (register.byId[id]) id = parentId + '-' + slugify(name).slice(0, 27) + '-' + (n++);
  var now = nowIso();
  appendRowFromObject(getCategoriesSheet(owner.OwnerId), {
    CategoryId: id, CategoryName: name, ParentCategoryId: parentId, Description: String(r.SellerNote || '').slice(0, 300),
    Keywords: keywords, Synonyms: '', PermittedProductTypes: parent.types.join(', '), RequiredAttributes: '', RecommendedAttributes: '',
    // With no kind of its own the new category takes part in the checks only
    // through its keywords, matched as its own kind (its id).
    Kind: kind || (keywords ? id : ''), AlsoListedIn: '', Status: 'active', CreatedAt: now, CreatedBy: owner.OwnerId, UpdatedAt: now, UpdatedBy: owner.OwnerId
  });
  invalidateListingRegister();
  return { ok: true, categoryId: id, parentId: parentId, path: parent.name + ' → ' + name };
}

/**
 * After the register changes, re-run the checks on every held listing and
 * note the result on its open case. Nothing is published automatically -
 * an admin still decides - but the queue shows which ones would now pass.
 */
function revalidateHeldProducts(register) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Product_Review_Queue');
  if (!sheet) return 0;
  var held = sheetToObjects(getSheet('Products')).filter(function (p) { return String(p.Status) === 'review'; });
  var cases = sheetToObjects(sheet);
  var count = 0;
  held.forEach(function (p) {
    var open = findOpenListingCase(cases, p.ProductId);
    if (!open) return;
    var v = validateListing(productListingInput(p, activeVariantsOf(p.ProductId)), register);
    updateRowFromObject(sheet, open.__row, {
      ValidationJson: JSON.stringify({ severity: v.severity, blocked: v.blocked, issues: v.issues, suggestions: v.suggestions, recheckedAt: nowIso() }).slice(0, 20000)
    });
    count++;
  });
  return count;
}

/* ==================== Admin: the register ==================== */

function actionAdminListCategories(owner) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminListCategories');
  var sheet = getCategoriesSheet(owner.OwnerId);
  var counts = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.Status === 'archived' || p.Status === 'deleted') return;
    var c = categoryIdOf(p.Category);
    counts[c] = (counts[c] || 0) + 1;
    if (p.SubcategoryId) counts[p.SubcategoryId] = (counts[p.SubcategoryId] || 0) + 1;
  });
  return ok({
    categories: sheetToObjects(sheet).map(function (r) {
      return { id: r.CategoryId, name: r.CategoryName, parentId: r.ParentCategoryId, keywords: r.Keywords, synonyms: r.Synonyms,
        required: r.RequiredAttributes, recommended: r.RecommendedAttributes, kind: r.Kind, status: r.Status, products: counts[r.CategoryId] || 0,
        updatedAt: r.UpdatedAt };
    })
  });
}

/**
 * Edits one register row: status (active/inactive), keywords, synonyms,
 * required / recommended details, and a subcategory's name. Never deletes:
 * a category products still point at is switched off instead, and those
 * products stay where they are. Renaming is safe - products store the id.
 */
function actionAdminSaveCategory(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminSaveCategory', body && body.categoryId);
  body = body || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getCategoriesSheet(owner.OwnerId);
    var row = findRowById(sheet, 'CategoryId', String(body.categoryId || ''));
    if (!row) return fail('Category not found');
    var update = {};
    if (body.status !== undefined) {
      var st = String(body.status);
      if (st !== 'active' && st !== 'inactive') return fail('Status is active or inactive.');
      if (st === 'inactive' && row.CategoryId === 'other') return fail('Other cannot be switched off.');
      update.Status = st;
    }
    if (body.name !== undefined) {
      if (!row.ParentCategoryId) return fail('Top-level names are fixed in the site code. Rename a subcategory only.');
      var nameErr = categoryNameError(body.name);
      if (nameErr) return fail(nameErr);
      update.CategoryName = String(body.name).replace(/\s+/g, ' ').trim();
    }
    ['keywords', 'synonyms'].forEach(function (k) {
      if (body[k] === undefined) return;
      update[k === 'keywords' ? 'Keywords' : 'Synonyms'] = String(body[k]).slice(0, 1000);
    });
    var attrErr = '';
    ['required', 'recommended'].forEach(function (k) {
      if (body[k] === undefined) return;
      var keys = listingSplitList(body[k]);
      keys.forEach(function (a) { if (!LISTING_ATTRIBUTES[a]) attrErr = 'Unknown detail "' + a + '". Use: ' + Object.keys(LISTING_ATTRIBUTES).join(', '); });
      update[k === 'required' ? 'RequiredAttributes' : 'RecommendedAttributes'] = keys.join(', ');
    });
    if (attrErr) return fail(attrErr);
    if (!Object.keys(update).length) return fail('Nothing to change');
    var previous = {};
    Object.keys(update).forEach(function (k) { previous[k] = row[k]; });
    update.UpdatedAt = nowIso();
    update.UpdatedBy = owner.OwnerId;
    updateRowFromObject(sheet, row.__row, update);
    invalidateListingRegister();
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'CATEGORY_UPDATED', entityType: 'category', entityId: row.CategoryId,
      previous: previous, next: update, requestId: body.requestId });
    return ok({});
  } finally {
    lock.releaseLock();
  }
}

/** Last audit entries for one entity (admin only), newest first. */
function actionListAuditLog(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'listAuditLog');
  var sheet = SpreadsheetApp.getActive().getSheetByName('Audit_Log');
  if (!sheet) return ok({ entries: [] });
  var id = String((body && body.entityId) || '');
  var rows = sheetToObjects(sheet).filter(function (r) { return !id || String(r.EntityId).indexOf(id) !== -1; });
  return ok({
    entries: rows.slice(-50).reverse().map(function (r) {
      return { at: r.Timestamp, actorId: r.ActorId, role: r.ActorRole, action: r.Action, entityType: r.EntityType, entityId: r.EntityId,
        previous: r.PreviousStateSummary, next: r.NewStateSummary, reason: r.Reason };
    })
  });
}
