/**
 * Web app entry points. Deploy: Deploy > New deployment > Web app,
 * Execute as "Me", Access "Anyone". See README.md for full setup steps.
 *
 * GET is used for simple public reads, POST for everything else (mutating
 * actions and anything carrying an auth token). Both avoid CORS preflights
 * by never using a custom Authorization header - the token travels inside
 * the JSON body instead.
 */

var PUBLIC_POST_ACTIONS = [
  'registerOwner', 'loginOwner', 'createOrder', 'createBookingRequest',
  'verifyLoginCode', 'requestPasswordReset', 'resetPasswordWithCode',
  'saveAbandonedCart', 'recordProductViews', 'recordStoreVisit',
  // Chat: these three serve BOTH sides of a conversation (anonymous customer
  // or a vendor with a token) from one action each, so they can't sit only
  // in PROTECTED_POST_ACTIONS - they do their own optional auth internally
  // via resolveChatRequest() in Chat.gs. See that file for why.
  'sendMessage', 'getConversation', 'markAsRead', 'sendChatImage', 'setTyping',
  // Meetings: same shape as the chat actions just above - both sides call
  // these from one action each, doing their own internal auth via
  // resolveMeetingActor() in Meetings.gs (which itself composes
  // resolveChatRequest, requireAuth and requireCustomerAuth - see that
  // file's header for the full identity story).
  'requestMeeting', 'startVideoCallNow', 'respondToMeeting', 'retryMeetingSpace', 'cancelMeeting',
  'endMeeting', 'listMeetingsForConversation',
  // Customer accounts (passwordless email code) - all public; getProfile/logout
  // validate their own customer token internally via requireCustomerAuth.
  'registerCustomer', 'verifyCustomerEmail', 'loginCustomer', 'verifyCustomerLogin',
  'getCustomerProfile', 'logoutCustomer', 'getCustomerStore',
  // Google Sign-In, customers only. Public because it IS the sign-in: it
  // validates the Google ID token itself (CustomerOAuth.gs) before issuing a
  // session, and refuses everything when GOOGLE_CLIENT_ID is unset.
  'googleSignIn',
  'listCustomerOrders', 'listCustomerBookings', 'updateCustomerProfile',
  'getCustomerInbox',
  // Marketing (Marketing.gs): the customer's own opt-in (customer token
  // checked inside), the one-tap unsubscribe (random per-customer token), and
  // an email-link click (counted only for a real, sent email).
  'getMarketingPreference', 'setMarketingPreference', 'unsubscribeMarketing', 'recordMarketingClick',
  // Customer-managed orders/bookings. Public in the same sense as the rest of
  // this block: each one calls requireCustomerAuth on body.token internally
  // (via findOwnRow in Customers.gs) and refuses any row that is not the
  // authenticated customer's own.
  'updateCustomerOrder', 'updateCustomerBooking',
  'setCustomerOrderArchived', 'setCustomerBookingArchived',
  // Reviews: submitReview does its own customer auth internally (a review
  // requires a signed-in customer), same pattern as the account actions above.
  'submitReview'
];
var PROTECTED_POST_ACTIONS = [
  'logoutOwner', 'getOwnerProfile', 'updateOwnerProfile', 'listOwnerProducts',
  'createProduct', 'updateProduct', 'deleteProduct', 'uploadProductImage', 'uploadStoreLogo',
  'uploadOwnerIdLicense',
  'listOwnerOrders', 'updateOrderStatus', 'setStoreStatus',
  'listOwnerBookings', 'updateBookingStatus',
  'enable2FARequest', 'confirm2FASetup', 'disable2FA',
  'getVendorConversations', 'deleteConversation', 'archiveConversation', 'getUnreadCount',
  'listFeatured', 'addFeatured', 'removeFeatured',
  'listSellerBadges', 'setSellerBadgeOverride', 'setBadgeConfig', 'recomputeBadges',
  'listWholesalers', 'setWholesaleVerified',
  'startFeaturePurchase', 'listMyFeaturePurchases', 'submitFeaturePayment',
  'listFeaturePurchases', 'setFeaturePurchaseStatus', 'setFeatureBankMatched', 'adminSearch', 'adminStoreAnalytics',
  'getInventory', 'receiveStock', 'adjustStock', 'updateStockSettings', 'listStockMovements',
  'listInventoryConnections', 'saveInventoryConnection', 'deleteInventoryConnection', 'previewInventoryImport',
  'applyInventoryImport', 'listSyncJobs', 'exportInventoryRows',
  'testSheetConnection', 'syncNow', 'listSyncConflicts', 'resolveSyncConflict',
  'listLocations', 'saveLocation', 'archiveLocation', 'transferStock', 'listSuppliers', 'saveSupplier', 'archiveSupplier', 'inventoryReport',
  'adminInventoryOverview',
  // Marketing engine - every one checks isOwnerAdmin inside (Marketing.gs).
  'getMarketingOverview', 'createMarketingCampaign', 'setMarketingCampaignStatus', 'setMarketingPaused',
  'previewMarketingCampaign', 'getMarketingStats', 'runMarketingGeneration',
  // Listing checks + review queue (ListingReview.gs). requestCategory and
  // listMyReviewCases are the seller's own; the rest check isOwnerAdmin inside.
  'requestCategory', 'listMyReviewCases',
  'listReviewCases', 'getReviewCase', 'reviewCaseAction', 'adminListCategories', 'adminSaveCategory', 'listAuditLog',
  // Per-variant photo galleries (ProductVariants.gs) - owner of the product only.
  'uploadVariantImage', 'setVariantImages'
];

// Chat send abuse guard: burst cap catches a stuck retry loop, sustained cap
// catches a script deliberately flooding a vendor's inbox/Drive storage.
// Both are anonymous-safe (see chatRateLimitIdentity) - not full abuse
// resistance (no IP is available to key on, and a customerToken can be
// reset by clearing localStorage), just a backstop against naive flooding.
var CHAT_RATE_LIMIT_ACTIONS = ['sendMessage', 'sendChatImage'];
var CHAT_BURST_MAX = 5;
var CHAT_BURST_WINDOW_SECONDS = 10;
var CHAT_SUSTAINED_MAX = 30;
var CHAT_SUSTAINED_WINDOW_SECONDS = 60;

// Build stamp reported by the public 'getVersion' action. Apps Script serves a
// frozen snapshot of the last SAVED files, so an editor that looks up to date
// tells you nothing about what the /exec URL is actually running. Hitting
// /exec?action=getVersion answers that in one click. Bump this whenever the
// apps-script/ files change, then confirm the live URL echoes the new value
// after redeploying (see README.md).
var APP_VERSION = 'adminsearch2-2026-10-09';

/**
 * Identity for chat rate limiting: a vendor calling with a session token is
 * keyed on that raw token; an anonymous customer is keyed on their
 * customerToken. Returns null if neither is present (including body itself
 * being missing), so a malformed request falls through to the action's own
 * validation (resolveChatRequest in Chat.gs) to produce the real error
 * instead of a misleading rate-limit one.
 */
function chatRateLimitIdentity(body) {
  if (!body) return null;
  if (body.token) return 'token:' + body.token;
  if (body.customerToken) return 'cust:' + body.customerToken;
  return null;
}

/**
 * Two-tier rate gate for the chat-sending actions, run in doPost BEFORE the
 * action dispatch - the closest thing to middleware this router has (same
 * spot PROTECTED_POST_ACTIONS' requireAuth gate already runs centrally).
 * Returns a fail() object (rateLimited:true) if either cap trips, or null
 * to let the request through - the action handlers stay unaware rate
 * limiting exists.
 */
function checkChatRateLimit(action, body) {
  if (CHAT_RATE_LIMIT_ACTIONS.indexOf(action) === -1) return null;
  var identity = chatRateLimitIdentity(body);
  if (!identity) return null;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var burstHit = rateLimitHit('ratelimit:chat:burst:' + identity, CHAT_BURST_MAX, CHAT_BURST_WINDOW_SECONDS);
    var sustainedHit = rateLimitHit('ratelimit:chat:sustained:' + identity, CHAT_SUSTAINED_MAX, CHAT_SUSTAINED_WINDOW_SECONDS);
    if (burstHit || sustainedHit) {
      var out = fail('You are sending messages too fast - please wait a moment and try again.');
      out.rateLimited = true;
      return out;
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sheet tabs this app's newer features depend on, with the exact header row
 * each one needs. Db.gs addresses columns purely by header NAME and does so
 * silently - appendRowFromObject drops a field whose header is absent and
 * sheetToObjects reads it back as undefined - so a single mistyped header
 * surfaces much later as a confusing runtime error (a mistyped Purpose here
 * makes a valid signup code report "invalid or has expired"). checkSetup
 * turns that class of misconfiguration into a direct answer.
 */
var REQUIRED_TABS = {
  Customers: ['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
  CustomerSessions: ['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'],
  CustomerCodes: ['Token', 'Email', 'Code', 'Purpose', 'Name', 'Phone', 'CreatedAt', 'ExpiresAt', 'Attempts'],
  Featured: ['FeaturedId', 'Type', 'RefId', 'SortOrder', 'CreatedAt'],
  Reviews: ['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'CustomerName',
            'Rating', 'Comment', 'VerifiedPurchase', 'Status', 'CreatedAt', 'UpdatedAt'],
  // Both are derived or configuration - nothing but recomputeSellerBadges and
  // the admin page writes to them - so setupSheets repairing a header row here
  // can never touch a transaction the way it must never touch Orders.
  SellerBadges: ['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt'],
  BadgeConfig: ['Key', 'Value', 'UpdatedAt'],
  // Meeting requests + Google Meet video calls (Meetings.gs). Every meeting
  // is anchored to one Conversations row (ConversationId) - see that file's
  // header for why nothing here duplicates Conversations/Messages data.
  Meetings: ['MeetingId', 'RequesterId', 'RequesterType', 'RecipientId', 'RecipientType',
             'ConversationId', 'StoreSlug', 'Purpose', 'Notes', 'RequestedDate', 'RequestedTime',
             'Timezone', 'Status', 'GoogleMeetSpaceName', 'GoogleMeetUrl', 'MeetFailureReason',
             'CreatedAt', 'AcceptedAt', 'ReadyAt', 'CancelledAt', 'EndedAt', 'LastUpdatedAt'],
  // Marketing engine (Marketing.gs, MarketingEngine.gs). New tabs only -
  // nothing existing changes. SourceKey makes automatic campaigns one per
  // period; Attempts drives the retry limit; UnsubscribeToken is the one-tap
  // unsubscribe; OptInAt records when consent was given.
  Campaigns: ['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson',
              'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl',
              'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients',
              'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey'],
  CampaignEvents: ['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt',
                   'SentAt', 'FailureReason', 'MetadataJson', 'Attempts'],
  MarketingPreferences: ['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit',
                         'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']
};

/**
 * Public setup self-check: reports which required tabs/headers are wrong and
 * whether the optional pieces are configured. Deliberately returns only tab
 * names, header names and booleans - never row contents, and never the
 * ADMIN_EMAILS value - because this action is unauthenticated. Header names
 * are already published in README.md, so they are not sensitive.
 */
function actionCheckSetup() {
  var problems = [];
  var tabs = Object.keys(REQUIRED_TABS).map(function (name) {
    var required = REQUIRED_TABS[name];
    var entry = { tab: name, exists: false, missingHeaders: [], untrimmedHeaders: [], unexpectedHeaders: [] };

    var raw;
    try {
      raw = getHeaders(getSheet(name));
    } catch (err) {
      // getSheet throws when the tab does not exist; report it rather than
      // aborting, so one missing tab still yields a full report.
      problems.push('Missing sheet tab: ' + name);
      return entry;
    }
    entry.exists = true;

    var headers = raw.map(function (h) { return String(h); });
    entry.missingHeaders = required.filter(function (h) { return headers.indexOf(h) === -1; });
    entry.unexpectedHeaders = headers.filter(function (h) {
      return h !== '' && required.indexOf(h) === -1;
    });
    // A header with stray whitespace looks correct in the Sheet but never
    // matches, so call it out separately from a plain typo.
    entry.untrimmedHeaders = headers.filter(function (h) {
      return h !== h.trim() && required.indexOf(h.trim()) !== -1;
    });

    if (entry.missingHeaders.length) {
      problems.push(name + ' is missing header(s): ' + entry.missingHeaders.join(', '));
    }
    if (entry.untrimmedHeaders.length) {
      problems.push(name + ' has header(s) with stray spaces: ' + entry.untrimmedHeaders.join(', '));
    }
    return entry;
  });

  // Each .gs file is pasted into the editor by hand, so a file can exist by
  // name yet be empty - which leaves its functions undefined. Probe one
  // function per file to catch that directly.
  var missingFiles = [];
  if (typeof actionRegisterCustomer !== 'function') missingFiles.push('Customers.gs');
  if (typeof actionGetTips !== 'function') missingFiles.push('Admin.gs');
  if (typeof actionSubmitReview !== 'function') missingFiles.push('Reviews.gs');
  // Every product save runs these two - a missing one stops ALL product saves.
  if (typeof validateListing !== 'function') missingFiles.push('ListingRules.gs');
  if (typeof listingSaveGate !== 'function') missingFiles.push('ListingReview.gs');
  if (typeof validateProductOptions !== 'function') missingFiles.push('ProductOptions.gs');
  if (typeof prepareVariantSave !== 'function') missingFiles.push('ProductVariants.gs');
  if (typeof sellerBadgeIndex !== 'function') missingFiles.push('Badges.gs');
  if (typeof actionRequestMeeting !== 'function') missingFiles.push('Meetings.gs');
  if (missingFiles.length) {
    problems.push('Script file(s) missing or empty: ' + missingFiles.join(', '));
  }

  var adminEmailsSet = false;
  try {
    adminEmailsSet = getAdminEmails().length > 0;
  } catch (err) {
    adminEmailsSet = false;
  }
  if (!adminEmailsSet) {
    problems.push('ADMIN_EMAILS script property is not set (needed only for the admin back-office)');
  }

  return ok({
    version: APP_VERSION,
    setupOk: problems.length === 0,
    problems: problems,
    tabs: tabs,
    missingFiles: missingFiles,
    adminEmailsSet: adminEmailsSet
  });
}

/**
 * One-time setup / repair for the tabs in REQUIRED_TABS. Run it from the Apps
 * Script editor: pick setupSheets in the function dropdown and press Run.
 *
 * Deliberately NOT wired into doGet/doPost. The web app is unauthenticated, so
 * an endpoint able to rewrite spreadsheet headers must not be reachable from
 * the internet; keeping this editor-only means it can only be invoked by
 * someone who already has edit access to the script.
 *
 * Creates a missing tab, and rewrites row 1 when the required headers are not
 * all present. It never reads, writes or deletes a data row. Rewriting row 1 is
 * safe on a broken tab because Db.gs matches columns by header NAME: a header
 * that does not match is one appendRowFromObject has never written to, so the
 * cells beneath it are empty by construction. The previous header row is logged
 * either way, so any surprise is recoverable.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  var lines = [];

  Object.keys(REQUIRED_TABS).forEach(function (name) {
    var required = REQUIRED_TABS[name];
    var sheet = ss.getSheetByName(name);

    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, required.length).setValues([required]);
      lines.push('CREATED   ' + name + ' -> ' + required.join(' | '));
      return;
    }

    // Order-independent: Db.gs looks columns up by name, so a tab whose headers
    // are all present but in a different order is already correct - leave it be
    // rather than shuffling columns that hold data.
    var existing = getHeaders(sheet).map(function (h) { return String(h); });
    var allPresent = required.every(function (h) { return existing.indexOf(h) !== -1; });
    if (allPresent) {
      lines.push('OK        ' + name);
      return;
    }

    sheet.getRange(1, 1, 1, required.length).setValues([required]);
    var line = 'REPAIRED  ' + name +
      '\n            was: ' + (existing.join(' | ') || '(empty)') +
      '\n            now: ' + required.join(' | ');
    if (sheet.getLastRow() > 1) {
      line += '\n            NOTE: this tab already has data rows - check that they still line up.';
    }
    lines.push(line);
  });

  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

/**
 * Diagnostic for a signup/login code that will not verify. Run it from the Apps
 * Script editor (function dropdown -> debugCustomerCodes -> Run), then read the
 * Execution log.
 *
 * Every value is printed via JSON.stringify so invisible characters show up as
 * what they are: "signup" and "signup " are indistinguishable in a cell, but
 * obvious here. That matters because consumeCustomerEmailCode compares these
 * values exactly.
 *
 * Editor-only, never a web action - it reads one-time codes, so it must not be
 * reachable from the internet. Tokens are printed as a prefix plus length
 * rather than in full: enough to match a row, not enough to reuse as a
 * credential if the log is shared.
 */
function debugCustomerCodes() {
  var sheet = getSheet('CustomerCodes');
  var headers = getHeaders(sheet).map(function (h) { return String(h); });
  var rows = sheetToObjects(sheet);
  var now = Date.now();

  var lines = [];
  lines.push('Headers (' + headers.length + '): ' + JSON.stringify(headers));
  lines.push('Expected     : ' + JSON.stringify(REQUIRED_TABS.CustomerCodes));
  lines.push('Headers match: ' + REQUIRED_TABS.CustomerCodes.every(function (h) {
    return headers.indexOf(h) !== -1;
  }));
  lines.push('Data rows: ' + rows.length);
  lines.push('Now: ' + new Date(now).toISOString());

  if (rows.length === 0) {
    lines.push('(no rows - request a code, then run this again)');
  }

  // Newest few only; a long history adds noise without adding signal.
  rows.slice(-5).forEach(function (r) {
    var tok = String(r.Token == null ? '' : r.Token);
    var expiresMs = new Date(r.ExpiresAt).getTime();
    lines.push(
      'row ' + r.__row +
      ' Token=' + (tok ? tok.slice(0, 8) + '...(len ' + tok.length + ')' : '(blank)') +
      ' Email=' + JSON.stringify(String(r.Email)) +
      ' Code=' + JSON.stringify(String(r.Code)) +
      ' Purpose=' + JSON.stringify(String(r.Purpose)) +
      ' Attempts=' + JSON.stringify(String(r.Attempts)) +
      ' ExpiresAt=' + JSON.stringify(String(r.ExpiresAt)) +
      ' expired=' + (isNaN(expiresMs) ? 'UNPARSEABLE' : (expiresMs < now))
    );
  });

  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    switch (params.action) {
      case 'listStores': return jsonOut(actionListStores(params));
      case 'listProducts': return jsonOut(markPaidFeatured(actionListProducts(params)));
      case 'getStorePublicInfo': return jsonOut(actionGetStorePublicInfo(params));
      case 'searchProducts': return jsonOut(markPaidFeatured(actionSearchProducts(params)));
      case 'listTopProducts': return jsonOut(markPaidFeatured(actionListTopProducts()));
      case 'listTopStores': return jsonOut(actionListTopStores());
      case 'getHomePageData': return jsonOut(markPaidFeatured(actionGetHomePageData()));
      case 'getTips': return jsonOut(markPaidFeatured(actionGetTips(params)));
      case 'listProductReviews': return jsonOut(actionListProductReviews(params));
      case 'listCategories': return jsonOut(actionListCategories());
      // Deploy health probe: no auth, no Sheets access, so it answers even on a
      // half-configured project - it can only report the running build or, if
      // absent, prove the deployment is stale.
      case 'getVersion': return jsonOut(ok({ version: APP_VERSION }));
      case 'checkSetup': return jsonOut(actionCheckSetup());
      default: return jsonOut(fail('Unknown action: ' + params.action));
    }
  } catch (err) {
    return jsonOut(fail(err.message || String(err)));
  }
}

function doPost(e) {
  try {
    var body = parsePostBody(e);
    var action = body.action;

    if (PUBLIC_POST_ACTIONS.indexOf(action) !== -1) {
      var rateLimitFail = checkChatRateLimit(action, body);
      if (rateLimitFail) return jsonOut(rateLimitFail);

      switch (action) {
        case 'registerOwner': return jsonOut(actionRegisterOwner(body));
        case 'loginOwner': return jsonOut(actionLoginOwner(body));
        case 'createOrder': return jsonOut(actionCreateOrder(body));
        case 'createBookingRequest': return jsonOut(actionCreateBookingRequest(body));
        case 'verifyLoginCode': return jsonOut(actionVerifyLoginCode(body));
        case 'requestPasswordReset': return jsonOut(actionRequestPasswordReset(body));
        case 'resetPasswordWithCode': return jsonOut(actionResetPasswordWithCode(body));
        case 'saveAbandonedCart': return jsonOut(actionSaveAbandonedCart(body));
        case 'recordProductViews': return jsonOut(actionRecordProductViews(body));
        case 'recordStoreVisit': return jsonOut(actionRecordStoreVisit(body));
        case 'sendMessage': return jsonOut(actionSendMessage(body));
        case 'getConversation': return jsonOut(actionGetConversation(body));
        case 'markAsRead': return jsonOut(actionMarkAsRead(body));
        case 'sendChatImage': return jsonOut(actionSendChatImage(body));
        case 'setTyping': return jsonOut(actionSetTyping(body));
        case 'requestMeeting': return jsonOut(actionRequestMeeting(body));
        case 'startVideoCallNow': return jsonOut(actionStartVideoCallNow(body));
        case 'respondToMeeting': return jsonOut(actionRespondToMeeting(body));
        case 'retryMeetingSpace': return jsonOut(actionRetryMeetingSpace(body));
        case 'cancelMeeting': return jsonOut(actionCancelMeeting(body));
        case 'endMeeting': return jsonOut(actionEndMeeting(body));
        case 'listMeetingsForConversation': return jsonOut(actionListMeetingsForConversation(body));
        case 'registerCustomer': return jsonOut(actionRegisterCustomer(body));
        case 'verifyCustomerEmail': return jsonOut(actionVerifyCustomerEmail(body));
        case 'loginCustomer': return jsonOut(actionLoginCustomer(body));
        case 'googleSignIn': return jsonOut(actionGoogleSignIn(body));
        case 'verifyCustomerLogin': return jsonOut(actionVerifyCustomerLogin(body));
        case 'getCustomerProfile': return jsonOut(actionGetCustomerProfile(body));
        case 'getCustomerStore': return jsonOut(actionGetCustomerStore(body));
        case 'logoutCustomer': return jsonOut(actionLogoutCustomer(body));
        case 'updateCustomerOrder': return jsonOut(actionUpdateCustomerOrder(body));
        case 'updateCustomerBooking': return jsonOut(actionUpdateCustomerBooking(body));
        case 'setCustomerOrderArchived': return jsonOut(actionSetCustomerOrderArchived(body));
        case 'setCustomerBookingArchived': return jsonOut(actionSetCustomerBookingArchived(body));
        case 'listCustomerOrders': return jsonOut(actionListCustomerOrders(body));
        case 'listCustomerBookings': return jsonOut(actionListCustomerBookings(body));
        case 'updateCustomerProfile': return jsonOut(actionUpdateCustomerProfile(body));
        case 'getCustomerInbox': return jsonOut(actionGetCustomerInbox(body));
        case 'getMarketingPreference': return jsonOut(actionGetMarketingPreference(body));
        case 'setMarketingPreference': return jsonOut(actionSetMarketingPreference(body));
        case 'unsubscribeMarketing': return jsonOut(actionUnsubscribeMarketing(body));
        case 'recordMarketingClick': return jsonOut(actionRecordMarketingClick(body));
        case 'submitReview': return jsonOut(actionSubmitReview(body));
      }
    }

    if (action === 'logoutOwner') return jsonOut(actionLogoutOwner(body));

    if (PROTECTED_POST_ACTIONS.indexOf(action) !== -1) {
      var owner;
      try {
        owner = requireAuth(body.token);
      } catch (authErr) {
        return jsonOut(fail(authErr.message || 'Not authenticated'));
      }

      switch (action) {
        case 'getOwnerProfile': return jsonOut(actionGetOwnerProfile(owner));
        case 'updateOwnerProfile': return jsonOut(actionUpdateOwnerProfile(owner, body));
        case 'listOwnerProducts': return jsonOut(actionListOwnerProducts(owner, body));
        case 'createProduct':
        case 'updateProduct': return jsonOut(actionCreateOrUpdateProduct(owner, body));
        case 'deleteProduct': return jsonOut(actionDeleteProduct(owner, body));
        case 'uploadProductImage': return jsonOut(actionUploadProductImage(owner, body));
        case 'uploadStoreLogo': return jsonOut(actionUploadStoreLogo(owner, body));
        case 'uploadOwnerIdLicense': return jsonOut(actionUploadOwnerIdLicense(owner, body));
        case 'listOwnerOrders': return jsonOut(actionListOwnerOrders(owner, body));
        case 'updateOrderStatus': return jsonOut(actionUpdateOrderStatus(owner, body));
        case 'setStoreStatus': return jsonOut(actionSetStoreStatus(owner, body));
        case 'listOwnerBookings': return jsonOut(actionListOwnerBookings(owner, body));
        case 'updateBookingStatus': return jsonOut(actionUpdateBookingStatus(owner, body));
        case 'enable2FARequest': return jsonOut(actionEnable2FARequest(owner));
        case 'confirm2FASetup': return jsonOut(actionConfirm2FASetup(owner, body));
        case 'disable2FA': return jsonOut(actionDisable2FA(owner));
        case 'requestEmailChange': return jsonOut(actionRequestEmailChange(owner, body));
        case 'confirmEmailChange': return jsonOut(actionConfirmEmailChange(owner, body));
        case 'getVendorConversations': return jsonOut(actionGetVendorConversations(owner, body));
        case 'deleteConversation': return jsonOut(actionDeleteConversation(owner, body));
        case 'archiveConversation': return jsonOut(actionArchiveConversation(owner, body));
        case 'getUnreadCount': return jsonOut(actionGetUnreadCount(owner));
        case 'listFeatured': return jsonOut(actionListFeatured(owner, body));
        case 'addFeatured': return jsonOut(actionAddFeatured(owner, body));
        case 'removeFeatured': return jsonOut(actionRemoveFeatured(owner, body));
        case 'listSellerBadges': return jsonOut(actionListSellerBadges(owner, body));
        case 'setSellerBadgeOverride': return jsonOut(actionSetSellerBadgeOverride(owner, body));
        case 'listWholesalers': return jsonOut(actionListWholesalers(owner));
        case 'setWholesaleVerified': return jsonOut(actionSetWholesaleVerified(owner, body));
        case 'startFeaturePurchase': return jsonOut(actionStartFeaturePurchase(owner, body));
        case 'listMyFeaturePurchases': return jsonOut(actionListMyFeaturePurchases(owner));
        case 'submitFeaturePayment': return jsonOut(actionSubmitFeaturePayment(owner, body));
        case 'listFeaturePurchases': return jsonOut(actionListFeaturePurchases(owner));
        case 'setFeaturePurchaseStatus': return jsonOut(actionSetFeaturePurchaseStatus(owner, body));
        case 'setFeatureBankMatched': return jsonOut(actionSetFeatureBankMatched(owner, body));
        case 'adminSearch': return jsonOut(actionAdminSearch(owner, body));
        case 'adminStoreAnalytics': return jsonOut(actionAdminStoreAnalytics(owner, body));
        case 'getInventory': return jsonOut(actionGetInventory(owner));
        case 'receiveStock': return jsonOut(actionReceiveStock(owner, body));
        case 'adjustStock': return jsonOut(actionAdjustStock(owner, body));
        case 'updateStockSettings': return jsonOut(actionUpdateStockSettings(owner, body));
        case 'listStockMovements': return jsonOut(actionListStockMovements(owner, body));
        case 'listInventoryConnections': return jsonOut(actionListInventoryConnections(owner));
        case 'saveInventoryConnection': return jsonOut(actionSaveInventoryConnection(owner, body));
        case 'deleteInventoryConnection': return jsonOut(actionDeleteInventoryConnection(owner, body));
        case 'previewInventoryImport': return jsonOut(actionPreviewInventoryImport(owner, body));
        case 'applyInventoryImport': return jsonOut(actionApplyInventoryImport(owner, body));
        case 'listSyncJobs': return jsonOut(actionListSyncJobs(owner, body));
        case 'exportInventoryRows': return jsonOut(actionExportInventoryRows(owner));
        case 'testSheetConnection': return jsonOut(actionTestSheetConnection(owner, body));
        case 'syncNow': return jsonOut(actionSyncNow(owner, body));
        case 'listSyncConflicts': return jsonOut(actionListSyncConflicts(owner));
        case 'resolveSyncConflict': return jsonOut(actionResolveSyncConflict(owner, body));
        case 'listLocations': return jsonOut(actionListLocations(owner));
        case 'saveLocation': return jsonOut(actionSaveLocation(owner, body));
        case 'archiveLocation': return jsonOut(actionArchiveLocation(owner, body));
        case 'transferStock': return jsonOut(actionTransferStock(owner, body));
        case 'listSuppliers': return jsonOut(actionListSuppliers(owner));
        case 'saveSupplier': return jsonOut(actionSaveSupplier(owner, body));
        case 'archiveSupplier': return jsonOut(actionArchiveSupplier(owner, body));
        case 'inventoryReport': return jsonOut(actionInventoryReport(owner, body));
        case 'adminInventoryOverview': return jsonOut(actionAdminInventoryOverview(owner));
        case 'getMarketingOverview': return jsonOut(actionGetMarketingOverview(owner));
        case 'createMarketingCampaign': return jsonOut(actionCreateMarketingCampaign(owner, body));
        case 'setMarketingCampaignStatus': return jsonOut(actionSetMarketingCampaignStatus(owner, body));
        case 'setMarketingPaused': return jsonOut(actionSetMarketingPaused(owner, body));
        case 'previewMarketingCampaign': return jsonOut(actionPreviewMarketingCampaign(owner, body));
        case 'getMarketingStats': return jsonOut(actionGetMarketingStats(owner));
        case 'runMarketingGeneration': return jsonOut(actionRunMarketingGeneration(owner));
        case 'setBadgeConfig': return jsonOut(actionSetBadgeConfig(owner, body));
        case 'recomputeBadges': return jsonOut(actionRecomputeBadges(owner));
        case 'requestCategory': return jsonOut(actionRequestCategory(owner, body));
        case 'listMyReviewCases': return jsonOut(actionListMyReviewCases(owner));
        case 'listReviewCases': return jsonOut(actionListReviewCases(owner, body));
        case 'getReviewCase': return jsonOut(actionGetReviewCase(owner, body));
        case 'reviewCaseAction': return jsonOut(actionReviewCaseAction(owner, body));
        case 'adminListCategories': return jsonOut(actionAdminListCategories(owner));
        case 'adminSaveCategory': return jsonOut(actionAdminSaveCategory(owner, body));
        case 'listAuditLog': return jsonOut(actionListAuditLog(owner, body));
        case 'uploadVariantImage': return jsonOut(actionUploadVariantImage(owner, body));
        case 'setVariantImages': return jsonOut(actionSetVariantImages(owner, body));
      }
    }

    return jsonOut(fail('Unknown action: ' + action));
  } catch (err) {
    return jsonOut(fail(err.message || String(err)));
  }
}
