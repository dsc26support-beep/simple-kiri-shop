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
  'verifyLoginCode', 'requestPasswordReset', 'resetPasswordWithCode'
];
var PROTECTED_POST_ACTIONS = [
  'logoutOwner', 'getOwnerProfile', 'updateOwnerProfile', 'listOwnerProducts',
  'createProduct', 'updateProduct', 'deleteProduct', 'uploadProductImage',
  'listOwnerOrders', 'updateOrderStatus',
  'enable2FARequest', 'confirm2FASetup', 'disable2FA'
];

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    switch (params.action) {
      case 'listStores': return jsonOut(actionListStores());
      case 'listProducts': return jsonOut(actionListProducts(params));
      case 'getStorePublicInfo': return jsonOut(actionGetStorePublicInfo(params));
      case 'searchProducts': return jsonOut(actionSearchProducts(params));
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
        case 'listOwnerOrders': return jsonOut(actionListOwnerOrders(owner));
        case 'updateOrderStatus': return jsonOut(actionUpdateOrderStatus(owner, body));
        case 'enable2FARequest': return jsonOut(actionEnable2FARequest(owner));
        case 'confirm2FASetup': return jsonOut(actionConfirm2FASetup(owner, body));
        case 'disable2FA': return jsonOut(actionDisable2FA(owner));
      }
    }

    return jsonOut(fail('Unknown action: ' + action));
  } catch (err) {
    return jsonOut(fail(err.message || String(err)));
  }
}
