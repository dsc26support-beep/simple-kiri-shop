/**
 * The REAL Apps Script backend (apps-script/*.gs, via gas-harness) answering
 * a browser's requests in Playwright. Used by the POS end-to-end tests so the
 * till app, its sync engine and the server rules are tested together.
 *
 *   const be = makePosBackend();
 *   await be.attach(context);          // every Apps Script call goes to be
 *   be.down = true;                    // simulate no connection to Mwakete
 *   be.dropNextAnswer('posCheckout');  // the server handles it, the answer is lost
 */
const { makeBox } = require('./gas-harness.js');

function makePosBackend(extraSheets) {
  const FUT = new Date(Date.now() + 7 * 86400000).toISOString();
  const box = makeBox(Object.assign({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email', 'Phone', 'Island'],
      ['own_a', 'a', 'Teraina Store', 'active', 'wholesaler', 'a@x.test', '73000001', 'Tarawa'], ['own_b', 'b', 'Other Store', 'active', '', 'b@x.test', '', '']],
    Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-owner-a', 'own_a', '', FUT], ['tok-owner-b', 'own_b', '', FUT]],
    Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'], ['p_rice', 'own_a', 'Rice', 'active', 'food'], ['p_tuna', 'own_a', 'Tuna can', 'active', 'food'],
      ['p_soap', 'own_a', 'Soap', 'active', 'home'], ['p_b', 'own_b', 'Flour', 'active', 'food']],
    Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'CostPrice', 'PriceTiersJson', 'MinOrderQty', 'ReorderLevel'],
      ['v_rice', 'p_rice', 'own_a', '1kg', 2.5, 'RICE1', 100, 'active', 0, '0093000017', 1.6, '[{"minQty":10,"price":2.2}]', '', 5],
      ['v_tuna', 'p_tuna', 'own_a', '185g', 1.8, 'TUNA', 6, 'active', 0, '9300000012345', 1.1, '', '', 2],
      ['v_soap', 'p_soap', 'own_a', 'Bar', 1.2, 'SOAP', 40, 'active', 0, '', 0.6, '', '', 5],
      ['v_b', 'p_b', 'own_b', '25kg', 30, 'F1', 50, 'active', 0, '', 20, '', '', '']],
    Orders: [['OrderId', 'OwnerId', 'Status', 'Total', 'CreatedAt', 'CustomerName', 'DeliveryMethod'], ['ord1', 'own_a', 'Pending Payment', 25, '2026-10-27T00:00:00Z', 'Teraoi', 'pickup']]
  }, extraSheets || {}));
  box.__props.POS_HUB = 'on';
  box.__props.WHOLESALE_TIERS = 'on';
  box.__props.PEPPER = 'test-pepper';
  box.__props.PASSWORD_ITERATIONS = '1000';
  box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
  const be = {
    box, down: false, calls: [], drop: {}, accepted: [],
    handle(bodyText) {
      const out = box.doPost({ postData: { contents: bodyText } }).s;
      let action = '';
      try { action = JSON.parse(bodyText).action; } catch (e) { /* bad body */ }
      be.calls.push({ action, at: Date.now() });
      if (/^pos(Checkout|UploadSales|StockOp|UpdateItem)$/.test(action)) be.accepted.push({ action, at: Date.now() });
      return { action, out };
    },
    dropNextAnswer(action) { be.drop[action] = (be.drop[action] || 0) + 1; },
    async attach(context) {
      await context.route('**/script.google.com/**', async (route) => {
        if (be.down) return route.abort('internetdisconnected');
        const { action, out } = be.handle(route.request().postData() || '{}');
        if (be.drop[action]) { be.drop[action]--; return route.abort('connectionreset'); }
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out });
      });
    },
    sales: () => box.__sheets.PosSales ? box.__sheets.PosSales.objects() : [],
    stock: (id) => Number(box.__sheets.Variants.objects().find((v) => v.VariantId === id).StockQty)
  };
  return be;
}

module.exports = { makePosBackend };
