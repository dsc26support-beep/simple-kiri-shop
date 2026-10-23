/**
 * Owner request, Oct 2026, on the REAL backend sources (gas-harness):
 *  - sellers set a required password hint when registering; it is shown after
 *    a wrong password, never contains the password, and can be changed in
 *    Settings (with the current password when changing only the hint);
 *  - a seller's new-message email links to Messages with ?from=email;
 *  - a customer who is signed in while chatting is linked to the chat, gets an
 *    email when the seller replies (at most one per 10 minutes per chat), and
 *    can open their chats on another phone (claimCustomerChats). Guests can't
 *    send at all (viewers only), but can still read an older chat.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Username', 'PasswordHash', 'PasswordSalt', 'Email', 'Phone', 'Messenger', 'Status', 'CreatedAt', 'StoreType']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_t', 'Tia', 'tia@x.test', '73000001', 'yes', '', ''], ['cus_o', 'Other', 'o@x.test', '73000002', 'yes', '', ''], ['cus_b', 'Bong', 'bong@x.test', '73001234', 'true', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-tia', 'cus_t', '', FUT], ['c-other', 'cus_o', '', FUT], ['c-bong', 'cus_b', '', FUT]],
  Conversations: [['ConversationId', 'OwnerId', 'StoreSlug', 'CustomerToken', 'CustomerName', 'Status', 'CreatedAt', 'UpdatedAt', 'LastMessageAt', 'LastMessagePreview', 'LastSenderType', 'UnreadByVendor', 'UnreadByCustomer']],
  Messages: [['MessageId', 'ConversationId', 'OwnerId', 'StoreSlug', 'SenderType', 'Body', 'CreatedAt', 'ImageUrl', 'ImageFileId']]
});
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.PEPPER = 'test-pepper';
const owners = () => box.__sheets.Owners.objects();
const reg = (o) => box.actionRegisterOwner(Object.assign({ storeName: 'Bong Store', username: 'bong', password: 'coconut99', email: 'bong@x.test', phone: '73001234',
  messenger: 'bong.store', storeType: 'retailer', customerToken: 'c-bong', about: 'Rice and flour' }, o));

/* ---------- registration needs a hint ---------- */
let res = reg({ passwordHint: '' });
ok('register without a hint is refused', !res.ok && /password hint/i.test(res.error), J(res));
res = reg({ passwordHint: 'it is Coconut99 lol' });
ok('a hint containing the password is refused (any case)', !res.ok && /must not contain the password/.test(res.error), J(res));
res = reg({ passwordHint: 'coco nut 99' });
ok('...even with spaces in between', !res.ok && /must not contain the password/.test(res.error), J(res));
res = reg({ passwordHint: 'x'.repeat(101) });
ok('a hint over 100 characters is refused', !res.ok && /100 characters/.test(res.error), J(res));
res = reg({ passwordHint: 'favourite fruit + 99' });
ok('register with a good hint works', res.ok && owners()[0].PasswordHint === 'favourite fruit + 99', J(res));
// Since Oct 2026 a new store waits for an admin (SellerApplications.gs); approve it here.
ok('...as an application waiting for review', res.application && res.application.status === 'pending' && !res.token, J(res));
box.__sheets.Owners.grid[1][box.__sheets.Owners.grid[0].indexOf('ApprovalStatus')] = 'approved';
res = box.actionLoginOwner({ username: 'bong', password: 'coconut99' });
ok('the session profile says a hint is set, without the hint text', res.owner.hasPasswordHint === true && !('passwordHint' in res.owner), J(res.owner));
const ownerToken = res.token;

/* ---------- login ---------- */
res = box.actionLoginOwner({ username: 'bong', password: 'wrong-pass' });
ok('wrong password: fails and shows the hint', !res.ok && res.passwordHint === 'favourite fruit + 99' && /Invalid username or password/.test(res.error), J(res));
res = box.actionLoginOwner({ username: 'nobody', password: 'wrong-pass' });
ok('unknown username: fails with no hint', !res.ok && !res.passwordHint, J(res));
res = box.actionLoginOwner({ username: 'bong', password: 'coconut99' });
ok('right password logs in (no hint needed)', res.ok && !!res.token, J(res));

/* ---------- settings ---------- */
const me = () => box.__sheets.Owners.objects()[0];
const ownerRow = () => Object.assign({}, me(), { __row: 2 });
res = box.actionUpdateOwnerProfile(ownerRow(), { passwordHint: 'new hint' });
ok('changing only the hint needs the current password', !res.ok && /current password/i.test(res.error), J(res));
res = box.actionUpdateOwnerProfile(ownerRow(), { passwordHint: 'new hint', currentPassword: 'nope' });
ok('...the right one', !res.ok && /not right/i.test(res.error), J(res));
res = box.actionUpdateOwnerProfile(ownerRow(), { passwordHint: 'coconut99!', currentPassword: 'coconut99' });
ok('...and the new hint still must not contain it', !res.ok && /must not contain/.test(res.error), J(res));
res = box.actionUpdateOwnerProfile(ownerRow(), { passwordHint: 'my first boat', currentPassword: 'coconut99' });
ok('hint changed with the current password', res.ok && me().PasswordHint === 'my first boat', J(res));
box.__sheets.Owners.grid[1][box.__sheets.Owners.grid[0].indexOf('PasswordHint')] = 'boat2024';
res = box.actionUpdateOwnerProfile(ownerRow(), { newPassword: 'boat2024' });
ok('a new password that the current hint gives away is refused', !res.ok && /hint gives this password away/.test(res.error), J(res));
res = box.actionUpdateOwnerProfile(ownerRow(), { newPassword: 'lagoon2026', passwordHint: 'the blue water' });
ok('new password + new hint together, no current password needed', res.ok && me().PasswordHint === 'the blue water'
  && box.actionLoginOwner({ username: 'bong', password: 'lagoon2026' }).ok, J(res));
const old = Object.assign({}, me()); box.__sheets.Owners.grid[1][box.__sheets.Owners.grid[0].indexOf('PasswordHint')] = '';
ok('an older store without a hint is flagged for the dashboard reminder', box.publicOwnerFields(me()).hasPasswordHint === false);
box.__sheets.Owners.grid[1][box.__sheets.Owners.grid[0].indexOf('PasswordHint')] = old.PasswordHint;

/* ---------- chat emails ---------- */
const mail = box.__mail;
mail.length = 0;
res = box.actionSendMessage({ storeSlug: 'bong-store', customerToken: 'dev-tok-1', customerName: 'Tia', body: 'Is the rice in stock?', customerSession: 'c-tia' });
ok('signed-in customer message works', res.ok, J(res));
const conv = () => box.__sheets.Conversations.objects()[0];
ok('...and links the chat to their account (CustomerId)', conv().CustomerId === 'cus_t', J(conv()));
const sellerMail = mail.find((m) => m[0] === 'bong@x.test');
ok('the seller is emailed, with a link to Messages that brings them back after login', !!sellerMail && /\/owner\/messages\.html\?from=email/.test(JSON.stringify(sellerMail)), J(sellerMail));
mail.length = 0;
res = box.actionSendMessage({ token: ownerToken, conversationId: conv().ConversationId, body: 'Yes, 20 bags left.' });
ok('seller reply works', res.ok, J(res));
const custMail = mail.find((m) => m[0] === 'tia@x.test');
ok('the customer is emailed about the reply', !!custMail && /Bong Store replied/.test(custMail[1]) && /Yes, 20 bags left/.test(custMail[2]), J(custMail));
ok('...with a link to their Messages (?from=email)', /customer-messages\.html\?from=email/.test(JSON.stringify(custMail)));
mail.length = 0;
box.actionSendMessage({ token: ownerToken, conversationId: conv().ConversationId, body: 'And oil too.' });
ok('a second reply within 10 minutes sends no second email', !mail.some((m) => m[0] === 'tia@x.test'));
// Guests are viewers (owner decision, Oct 2026): no sign-in, no message.
res = box.actionSendMessage({ storeSlug: 'bong-store', customerToken: 'dev-tok-guest', customerName: 'Guest', body: 'Hello?', customerSession: '' });
ok('a guest cannot message a seller (asked to sign in)', !res.ok && res.signInRequired === true && /sign in/i.test(res.error), J(res));
ok('...and no chat is started for them', !box.__sheets.Conversations.objects().some((c) => c.CustomerToken === 'dev-tok-guest'));
res = box.actionSendMessage({ storeSlug: 'bong-store', customerToken: 'dev-tok-1', customerName: 'Tia', body: 'Thanks', customerSession: 'c-other' });
ok('a different signed-in customer on the same phone does not take over a linked chat', conv().CustomerId === 'cus_t');
res = box.actionSendMessage({ storeSlug: 'bong-store', customerToken: 'dev-tok-x', customerName: 'X', body: 'hi', customerSession: 'forged' });
ok('a bad customer session is refused like a guest', !res.ok && res.signInRequired === true && !box.__sheets.Conversations.objects().some((c) => c.CustomerToken === 'dev-tok-x'), J(res));
const readOnly = box.resolveChatRequest({ storeSlug: 'bong-store', customerToken: 'dev-tok-1' }, { createIfMissing: false });
ok('reading an existing chat still works without sign-in', readOnly.ok && !!readOnly.conversation, J(readOnly));

/* ---------- claim chats on another phone ---------- */
res = box.actionClaimCustomerChats({ customerSession: 'c-tia' });
ok('signed in: returns only their own chats', res.ok && res.chats.length === 1 && res.chats[0].storeSlug === 'bong-store' && res.chats[0].customerToken === 'dev-tok-1', J(res));
ok('another customer gets none of them', box.actionClaimCustomerChats({ customerSession: 'c-other' }).chats.length === 0);
ok('not signed in: refused', !box.actionClaimCustomerChats({}).ok);

let fails = 0;
console.log('\n--- password hints + message emails (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
