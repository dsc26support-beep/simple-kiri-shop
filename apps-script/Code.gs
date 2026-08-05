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
  'registerOwner', 'loginOwner', 'createOrder',
  'verifyLoginCode', 'requestPasswordReset', 'resetPasswordWithCode',
  'saveAbandonedCart', 'recordProductViews', 'recordStoreVisit',
  // Chat: these three serve BOTH sides of a conversation (anonymous customer
  // or a vendor with a token) from one action each, so they can't sit only
  // in PROTECTED_POST_ACTIONS - they do their own optional auth internally
  // via resolveChatRequest() in Chat.gs. See that file for why.
  'sendMessage', 'getConversation', 'markAsRead', 'sendChatImage'
];
var PROTECTED_POST_ACTIONS = [
  'logoutOwner', 'getOwnerProfile', 'updateOwnerProfile', 'listOwnerProducts',
  'createProduct', 'updateProduct', 'deleteProduct', 'uploadProductImage', 'uploadStoreLogo',
  'listOwnerOrders', 'updateOrderStatus', 'setStoreStatus',
  'enable2FARequest', 'confirm2FASetup', 'disable2FA',
  'getVendorConversations', 'deleteConversation', 'archiveConversation', 'getUnreadCount'
];

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    switch (params.action) {
      case 'listStores': return jsonOut(actionListStores());
      case 'listProducts': return jsonOut(actionListProducts(params));
      case 'getStorePublicInfo': return jsonOut(actionGetStorePublicInfo(params));
      case 'searchProducts': return jsonOut(actionSearchProducts(params));
      case 'listTopProducts': return jsonOut(actionListTopProducts());
      case 'listTopStores': return jsonOut(actionListTopStores());
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
      switch (action) {
        case 'registerOwner': return jsonOut(actionRegisterOwner(body));
        case 'loginOwner': return jsonOut(actionLoginOwner(body));
        case 'createOrder': return jsonOut(actionCreateOrder(body));
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
        case 'listOwnerProducts': return jsonOut(actionListOwnerProducts(owner));
        case 'createProduct':
        case 'updateProduct': return jsonOut(actionCreateOrUpdateProduct(owner, body));
        case 'deleteProduct': return jsonOut(actionDeleteProduct(owner, body));
        case 'uploadProductImage': return jsonOut(actionUploadProductImage(owner, body));
        case 'uploadStoreLogo': return jsonOut(actionUploadStoreLogo(owner, body));
        case 'listOwnerOrders': return jsonOut(actionListOwnerOrders(owner));
        case 'updateOrderStatus': return jsonOut(actionUpdateOrderStatus(owner, body));
        case 'setStoreStatus': return jsonOut(actionSetStoreStatus(owner, body));
        case 'enable2FARequest': return jsonOut(actionEnable2FARequest(owner));
        case 'confirm2FASetup': return jsonOut(actionConfirm2FASetup(owner, body));
        case 'disable2FA': return jsonOut(actionDisable2FA(owner));
        case 'getVendorConversations': return jsonOut(actionGetVendorConversations(owner));
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
