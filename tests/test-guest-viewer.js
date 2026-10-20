/**
 * Owner decision, Oct 2026: a guest is a viewer. Browsing stays open to
 * everyone; placing an order, sending a booking request, messaging a seller,
 * requesting or accepting a meeting and reviewing all need a signed-in
 * customer - refused on the SERVER (signInRequired), not only hidden in the
 * page. On the REAL backend sources (gas-harness, with NO default shopper).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 9e8).toISOString();
const PAST = new Date(Date.now() - 9e8).toISOString();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'StoreType'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'retailer']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_t', 'Tia', 'tia@x.test', '73000001', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-tia', 'cus_t', '', FUT], ['c-old', 'cus_t', '', PAST]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p1', 'own_s', 'bong', 'Bucket', 'Blue bucket', 'home', 'product', 'active', 0, '', ''],
    ['p2', 'own_s', 'bong', 'Canoe hire', 'Outrigger canoe', 'rentals', 'rental', 'active', 1, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v1', 'p1', 'own_s', 'One', 5, '', 50, 'active'], ['v2', 'p2', 'own_s', 'Per day', 20, '', 1, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'VariantId', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'Notes', 'StartDate', 'EndDate', 'Status', 'CreatedAt', 'UpdatedAt']],
  Conversations: [['ConversationId', 'OwnerId', 'StoreSlug', 'CustomerToken', 'CustomerName', 'Status', 'CreatedAt', 'UpdatedAt', 'LastMessageAt', 'LastMessagePreview', 'LastSenderType', 'UnreadByVendor', 'UnreadByCustomer', 'CustomerId'],
    ['conv_old', 'own_s', 'bong', 'guest-phone', 'Guest', 'open', '', '', '', 'Hi', 'customer', 0, 0, '']],
  Messages: [['MessageId', 'ConversationId', 'OwnerId', 'StoreSlug', 'SenderType', 'Body', 'CreatedAt', 'ImageUrl', 'ImageFileId'],
    ['msg_1', 'conv_old', 'own_s', 'bong', 'customer', 'Hi', new Date().toISOString(), '', '']],
  Meetings: [['MeetingId', 'ConversationId', 'Status']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'CustomerId', 'CustomerName', 'Rating', 'Comment', 'Status', 'CreatedAt']]
}, { guest: true });
box.__props.SITE_BASE_URL = 'https://mwakete.com';
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const order = (s) => { clear(); return box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v1', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
  customerEmail: 'typo@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash', customerSession: s }); };
const book = (s) => { clear(); return box.actionCreateBookingRequest({ storeSlug: 'bong', productId: 'p2', variantId: 'v2', startDate: day(3), endDate: day(4),
  customerName: 'Tia', customerPhone: '73000001', customerSession: s }); };
const msg = (s) => box.actionSendMessage({ storeSlug: 'bong', customerToken: 'guest-phone', customerName: 'Guest', body: 'Still there?', customerSession: s });
const refused = (r) => !r.ok && r.signInRequired === true && /sign in/i.test(r.error);

/* ---------- viewing stays open ---------- */
ok('a guest can browse a store', box.actionListProducts({ storeSlug: 'bong' }).products.length === 2);
ok('...and search', (box.actionSearchProducts({ q: 'bucket' }).products || []).length === 1);
ok('...and read reviews', box.actionListProductReviews({ productId: 'p1' }).ok);

/* ---------- ordering ---------- */
let r = order('');
ok('a guest cannot place an order', refused(r), J(r));
ok('...nothing is written', box.__sheets.Orders.objects().length === 0);
ok('a made-up session is refused the same way', refused(order('forged')));
ok('an expired session too', refused(order('c-old')));
r = order('c-tia');
ok('a signed-in customer can order', r.ok && !!r.orderId, J(r));
ok('...under their account email (so it is in My Account)', (box.__sheets.Orders.objects()[0] || {}).CustomerEmail === 'tia@x.test');

/* ---------- booking ---------- */
ok('a guest cannot send a booking request', refused(book('')));
r = book('c-tia');
ok('a signed-in customer can', r.ok, J(r));

/* ---------- messaging ---------- */
ok('a guest cannot send a message, even in a chat they started before', refused(msg('')));
ok('...nor a photo', refused(box.actionSendChatImage({ storeSlug: 'bong', customerToken: 'guest-phone', customerName: 'Guest', mimeType: 'image/jpeg', imageBase64: 'AAAA', customerSession: '' })));
ok('...but can still read that older chat', box.resolveChatRequest({ storeSlug: 'bong', customerToken: 'guest-phone' }, { createIfMissing: false }).conversation.ConversationId === 'conv_old');
r = msg('c-tia');
ok('signed in, they can reply - and the chat joins their account', r.ok && box.__sheets.Conversations.objects()[0].CustomerId === 'cus_t', J(r));
r = box.actionRequestMeeting({ storeSlug: 'bong', customerToken: 'guest-2', customerName: 'G', purpose: 'Look at canoe', requestedDate: day(2), requestedTime: '10:00' });
ok('a guest cannot request a meeting', !r.ok && /sign in/i.test(r.error), J(r));

/* ---------- reviews ---------- */
r = box.actionSubmitReview({ productId: 'p1', rating: 5 });
ok('a guest cannot review', !r.ok, J(r));

/* ---------- the pages ---------- */
const fs = require('fs'); const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
ok('checkout sends guests to sign in first, then back to checkout', /CustomerAuth\.signInUrl\('order', 'checkout\.html'\)/.test(read('assets/js/checkout.js')));
ok('checkout sends the customer session with the order', /customerSession: CustomerAuth\.getToken\(\)/.test(read('assets/js/checkout.js')));
ok('bookings send the session on both pages', ['assets/js/store.js', 'assets/js/product-page.js'].every((f) => /signInUrl\('book'\)/.test(read(f)) && /customerSession: CustomerAuth\.getToken\(\)/.test(read(f))));
ok('the chat window offers Sign in instead of the input for guests', /showSignInGate/.test(read('assets/js/chat-window.js')) && /signInUrl\('message'/.test(read('assets/js/chat-window.js')));

let fails = 0;
console.log('\n--- guests are viewers (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
