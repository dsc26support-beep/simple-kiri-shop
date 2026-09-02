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
  // Customer accounts (passwordless email code) - all public; getProfile/logout
  // validate their own customer token internally via requireCustomerAuth.
  'registerCustomer', 'verifyCustomerEmail', 'loginCustomer', 'verifyCustomerLogin',
  'getCustomerProfile', 'logoutCustomer',
  'listCustomerOrders', 'listCustomerBookings', 'updateCustomerProfile'
];
var PROTECTED_POST_ACTIONS = [
  'logoutOwner', 'getOwnerProfile', 'updateOwnerProfile', 'listOwnerProducts',
  'createProduct', 'updateProduct', 'deleteProduct', 'uploadProductImage', 'uploadStoreLogo',
  'uploadOwnerIdLicense',
  'listOwnerOrders', 'updateOrderStatus', 'setStoreStatus',
  'listOwnerBookings', 'updateBookingStatus',
  'enable2FARequest', 'confirm2FASetup', 'disable2FA',
  'getVendorConversations', 'deleteConversation', 'archiveConversation', 'getUnreadCount'
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

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    switch (params.action) {
      case 'listStores': return jsonOut(actionListStores(params));
      case 'listProducts': return jsonOut(actionListProducts(params));
      case 'getStorePublicInfo': return jsonOut(actionGetStorePublicInfo(params));
      case 'searchProducts': return jsonOut(actionSearchProducts(params));
      case 'listTopProducts': return jsonOut(actionListTopProducts());
      case 'listTopStores': return jsonOut(actionListTopStores());
      case 'getHomePageData': return jsonOut(actionGetHomePageData());
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
        case 'registerCustomer': return jsonOut(actionRegisterCustomer(body));
        case 'verifyCustomerEmail': return jsonOut(actionVerifyCustomerEmail(body));
        case 'loginCustomer': return jsonOut(actionLoginCustomer(body));
        case 'verifyCustomerLogin': return jsonOut(actionVerifyCustomerLogin(body));
        case 'getCustomerProfile': return jsonOut(actionGetCustomerProfile(body));
        case 'logoutCustomer': return jsonOut(actionLogoutCustomer(body));
        case 'listCustomerOrders': return jsonOut(actionListCustomerOrders(body));
        case 'listCustomerBookings': return jsonOut(actionListCustomerBookings(body));
        case 'updateCustomerProfile': return jsonOut(actionUpdateCustomerProfile(body));
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
        case 'getVendorConversations': return jsonOut(actionGetVendorConversations(owner, body));
        case 'deleteConversation': return jsonOut(actionDeleteConversation(owner, body));
        case 'archiveConversation': return jsonOut(actionArchiveConversation(owner, body));
        case 'getUnreadCount': return jsonOut(actionGetUnreadCount(owner));
      }
    }

    return jsonOut(fail('Unknown action: ' + action));
  } catch (err) {
    return jsonOut(fail(err.message || String(err)));
  }
}
