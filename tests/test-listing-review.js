/**
 * Listing checks + admin review queue (Oct 2026), on the REAL backend sources
 * (gas-harness): the rules engine, the product-save gate, the queue, category
 * requests, admin permissions, status transitions and the audit log.
 * Numbers in the test names are the owner brief's test list (1-31).
 */
const fs = require('fs');
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'StoreType'],
    ['own_s', 'shop', 'Shop', 'active', 'seller@example.com', 'wholesaler'],
    ['own_o', 'other', 'Other Shop', 'active', 'other@example.com', 'retailer'],
    ['own_a', 'adm', 'Admin', 'active', 'admin@mwakete.test', 'retailer']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageFileId',
    'ImageUrl2', 'ImageFileId2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['prod_old', 'own_s', 'shop', 'Old soap', '', 'household', 'product', '', '', '', '', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['var_old', 'prod_old', 'own_s', 'Bar', 2, '', '', 'active']],
  StockMovements: [['MovementId', 'OwnerId', 'ProductId', 'VariantId', 'Quantity', 'MovementType', 'PreviousStock', 'NewStock',
    'PreviousReserved', 'NewReserved', 'Source', 'ReferenceId', 'UserId', 'Notes', 'CreatedAt']]
});
box.__props.ADMIN_EMAILS = 'admin@mwakete.test';
const owners = () => box.__sheets.Owners.objects();
const S = owners().find((o) => o.OwnerId === 'own_s');
const O = owners().find((o) => o.OwnerId === 'own_o');
const A = owners().find((o) => o.OwnerId === 'own_a');
const products = () => box.__sheets.Products.objects();
const product = (id) => products().find((p) => p.ProductId === id);
const cases = () => (box.__sheets.Product_Review_Queue ? box.__sheets.Product_Review_Queue.objects() : []);
const audit = () => (box.__sheets.Audit_Log ? box.__sheets.Audit_Log.objects() : []);
const reg = () => box.getListingRegister();
const check = (o) => box.validateListing(Object.assign({ listingType: 'product', subcategoryId: '' }, o), reg());
const save = (who, o) => box.actionCreateOrUpdateProduct(who, Object.assign({ listingType: 'product', status: 'active',
  variants: [{ label: 'Standard', price: 2 }] }, o));
const act = (who, o) => box.actionReviewCaseAction(who, o);
const J = (x) => JSON.stringify(x).slice(0, 400);

/* ---------- 1-10: validation ---------- */
let v = check({ name: 'Water', description: 'Refreshing bottled water for everyday use.', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('1 Water + bottled-water description + Bottled Water: accepted', !v.blocked && !v.mismatch, J(v));
v = check({ name: 'Tuna', description: 'Canned tuna in springwater, 185g', categoryId: 'food', subcategoryId: 'food-canned-fish' });
ok('2 Tuna + canned-tuna description + Canned Fish & Tuna: accepted, no warnings', !v.blocked && v.severity === 'none', J(v));
v = check({ name: 'Water', description: 'The cheapest tuna in a can.', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('3 Water + canned-tuna description: high mismatch, blocked', v.blocked && v.severity === 'high' && v.rulesTriggered.includes('NAME_DESCRIPTION_MISMATCH'), J(v));
ok('3 ...explained in plain words, naming both', /name says ‘Water’.*description refers to tuna/.test(v.issues[0].message), v.issues[0].message);
ok('3 ...suggests Food & Groceries → Canned Fish & Tuna first', v.suggestions[0].path === 'Food & Groceries → Canned Fish & Tuna', J(v.suggestions));
v = check({ name: 'Canned Tuna', description: '', categoryId: 'fashion', subcategoryId: 'fashion-women' });
ok('4 Tuna + Women\'s Clothing: high mismatch, suggests Canned Fish & Tuna', v.blocked && v.rulesTriggered.includes('CATEGORY_NAME_MISMATCH')
  && v.suggestions[0].subcategoryId === 'food-canned-fish', J(v));
v = check({ name: 'Summer Dress', description: "Children's cotton dress.", categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('5 Dress + children\'s dress + Bottled Water: high mismatch, suggests clothing', v.blocked && v.suggestions.some((s) => s.categoryId === 'fashion'), J(v));
v = check({ name: 'Water', description: 'Pure drinking water. Goes great with a tuna sandwich.', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('6 water that mentions tuna as a pairing: not blocked', !v.blocked && !v.mismatch, J(v));
v = check({ name: 'Bottled water', description: 'Healthier than soft drinks and better than tuna brine!', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('6 ...or as a comparison: not blocked', !v.blocked && !v.mismatch, J(v));
v = check({ name: 'T-shirt', description: 'Hand wash in cold water', categoryId: 'fashion', subcategoryId: 'fashion-men' });
ok('6 ...washing instructions mentioning water are not a drink', !v.mismatch, J(v));
v = check({ name: 'Water tank 5000L', description: 'Strong plastic water tank', categoryId: 'home', subcategoryId: 'home-storage' });
ok('F "water tank" is storage, not a drink (word guards)', !v.mismatch, J(v));
v = check({ name: 'Water bottle', description: 'Steel drink bottle', categoryId: 'home', subcategoryId: 'home-kitchenware' });
ok('F "water bottle" is the container', !v.mismatch, J(v));
v = check({ name: 'Candle', description: 'Scented candles', categoryId: 'home' });
ok('F no substring matches ("can" never inside "candle")', !v.mismatch && v.severity === 'none', J(v));

// 7: mandatory details are off by default; switch one on in a register copy.
const rows = box.listingRegisterRows().map((r) => Object.assign({}, r));
rows.find((r) => r.id === 'food-bottled-water').required = 'volume';
const strict = box.buildListingRegister(rows);
v = box.validateListing({ name: 'Drinking water', description: 'Clean water', categoryId: 'food', subcategoryId: 'food-bottled-water', listingType: 'product' }, strict);
ok('7 a missing mandatory detail blocks, and cannot be sent for review', v.blocked && v.rulesTriggered.includes('ATTRIBUTE_REQUIRED') && !v.canSubmitForReview, J(v));
v = box.validateListing({ name: 'Drinking water', description: 'Clean water', categoryId: 'food', subcategoryId: 'food-bottled-water', listingType: 'product', optionLabels: ['600ml'] }, strict);
ok('7 ...read from an option label ("600ml") it passes', !v.blocked, J(v));
v = check({ name: 'Drinking water', description: 'Clean water', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('7 a missing RECOMMENDED detail is only a tip', !v.blocked && v.severity === 'low' && v.rulesTriggered.includes('ATTRIBUTE_RECOMMENDED'), J(v));

let res = save(S, { name: 'Rice', description: '', category: 'bogus' });
ok('8 a nonexistent category id is refused', !res.ok && /choose a category/i.test(res.error), J(res));
res = save(S, { name: 'Rice', description: '', category: 'food', subcategoryId: 'fashion-women' });
ok('8 a subcategory from another parent is refused', !res.ok && /subcategory/i.test(res.error), J(res));
res = save(S, { name: 'Rice', description: '', category: 'services', listingType: 'product' });
ok('8 a category that does not take this listing type is refused', !res.ok && /does not take products/.test(res.error), J(res));

// Seller saves the brief's example: refused with an explanation, nothing saved.
const before = products().length;
res = save(S, { name: 'Water', description: 'The cheapest tuna in a can.', category: 'food', subcategoryId: 'food-bottled-water', requestId: 'req-water-1' });
ok('Seller: a clear contradiction is refused, nothing saved, explanation + suggestions returned', !res.ok && res.needsReview && res.canSubmitForReview
  && products().length === before && res.validation.suggestions.length > 0, J(res));
ok('Audit: the validation failure is recorded', audit().some((a) => a.Action === 'VALIDATION_FAILED'));

// 9: the seller applies the suggestion and edits the name -> it passes.
res = save(S, { name: 'Tuna in a can', description: 'The cheapest tuna in a can.', category: 'food', subcategoryId: 'food-canned-fish', requestId: 'req-tuna-1' });
ok('9 a valid correction passes and publishes', res.ok && !res.held && product(res.productId).Status === 'active', J(res));
const tunaId = res.productId;

// 10: the same Save twice (same requestId) -> one product.
const n1 = products().length;
const again = save(S, { name: 'Tuna in a can', description: 'The cheapest tuna in a can.', category: 'food', subcategoryId: 'food-canned-fish', requestId: 'req-tuna-1' });
ok('10 a retried Save returns the same product, no duplicate', again.ok && again.productId === tunaId && products().length === n1, J(again));

/* ---------- 11-20: review queue ---------- */
res = save(S, { name: 'Water', description: 'The cheapest tuna in a can.', category: 'food', subcategoryId: 'food-bottled-water',
  submitForReview: true, sellerNote: 'It really is water, the tuna is the free gift', requestId: 'req-water-2' });
const waterId = res.productId;
ok('11 submit for review: saved HELD (not live), case opened with the product reference', res.ok && res.held && product(waterId).Status === 'review'
  && cases().some((c) => c.ProductId === waterId && c.Status === 'PENDING' && c.CaseType === 'LISTING'), J(res));
const waterCase = cases().find((c) => c.ProductId === waterId);
ok('11 ...the case keeps a snapshot of what was submitted', waterCase.ProductNameSnapshot === 'Water' && /tuna/.test(waterCase.DescriptionSnapshot)
  && waterCase.SelectedSubcategoryId === 'food-bottled-water' && waterCase.Severity === 'high' && waterCase.SellerDisputed === 'true');
const publicList = box.actionListProducts({ storeSlug: 'shop' }).products || [];
ok('11 a held listing is not public (the store\'s live ones are)', publicList.length > 0 && !publicList.some((p) => p.productId === waterId), J(publicList.map((p) => p.name)));

res = save(S, { productId: waterId, name: 'Water', description: 'The cheapest tuna in a can.', category: 'food', subcategoryId: 'food-bottled-water',
  submitForReview: true, status: 'active', requestId: 'req-water-3' });
ok('12 saving again while held does not open a second case', cases().filter((c) => c.ProductId === waterId).length === 1, J(cases().map((c) => c.ReviewId)));
ok('28 ...and the seller cannot un-hold it by sending status "active"', product(waterId).Status === 'review');

res = box.actionListReviewCases(S, {});
ok('13 a seller cannot list the review queue', !res.ok && res.error === 'Not authorized');
res = box.actionGetReviewCase(S, { reviewId: waterCase.ReviewId });
ok('13 ...or open a case', !res.ok);
ok('13 ...and the attempt is audited', audit().some((a) => a.Action === 'UNAUTHORIZED_ATTEMPT' && a.ActorId === 'own_s'));
res = act(S, { reviewId: waterCase.ReviewId, decision: 'override', reason: 'I approve my own listing' });
ok('14 a seller cannot resolve a case through the API', !res.ok && res.error === 'Not authorized' && product(waterId).Status === 'review');

// Admin view + metrics come from the rows.
res = box.actionListReviewCases(A, {});
ok('Admin: queue lists the case with real metrics', res.ok && res.cases.some((c) => c.reviewId === waterCase.ReviewId)
  && res.metrics.pending === 1 && res.metrics.highPriority === 1 && res.metrics.disputed === 1, J(res.metrics));
res = box.actionListReviewCases(A, { q: 'water' });
ok('Admin: search by product name', res.ok && res.cases.length === 1);
res = box.actionListReviewCases(A, { q: waterId });
ok('Admin: search by product id', res.ok && res.cases.length === 1);
res = box.actionListReviewCases(A, { severity: 'low' });
ok('Admin: filters apply (severity)', res.ok && res.cases.length === 0);
let full = box.actionGetReviewCase(A, { reviewId: waterCase.ReviewId });
ok('Admin: the case view has the product now, the check rerun and the history', full.ok && full.case.product.name === 'Water'
  && full.case.currentValidation.blocked && full.case.history.length >= 2, J(full.case && full.case.history));

// 16: Approve on a still-blocked listing is refused.
let ver = full.case.version;
res = act(A, { reviewId: waterCase.ReviewId, decision: 'approve', expectedVersion: ver });
ok('16 an admin cannot publish a still-failing listing with Approve', !res.ok && /still fails a check/.test(res.error) && product(waterId).Status === 'review', J(res));

// 19: invalid transitions.
res = act(A, { reviewId: waterCase.ReviewId, decision: 'close', expectedVersion: ver });
ok('19 an open case cannot be "closed" without a decision', !res.ok && /Only a decided case/.test(res.error));
res = act(A, { reviewId: waterCase.ReviewId, decision: 'publish-now', expectedVersion: ver });
ok('19 unknown actions are refused', !res.ok && /Unknown review action/.test(res.error));

// 18: request correction.
res = act(A, { reviewId: waterCase.ReviewId, decision: 'requestCorrection', expectedVersion: ver, reason: 'short' });
ok('18 a correction request needs a reason', !res.ok && /reason/.test(res.error));
box.__mail.length = 0;
res = act(A, { reviewId: waterCase.ReviewId, decision: 'requestCorrection', expectedVersion: ver, reason: 'Please make the name and description describe the same product.' });
ok('18 correction requested: status CORRECTION_REQUIRED, reason kept, seller emailed', res.ok && res.status === 'CORRECTION_REQUIRED'
  && cases().find((c) => c.ReviewId === waterCase.ReviewId).ResolutionReason.startsWith('Please make')
  && box.__mail.some((m) => m[0] === 'seller@example.com' && /correct your listing/.test(m[1])), J(res));
const mine = box.actionListMyReviewCases(S);
ok('Seller: sees the correction request, not internal notes', mine.ok && mine.cases[0].adminMessage.startsWith('Please make') && !('history' in mine.cases[0]));

// 29: a second admin acting on the version they opened is refused.
res = act(A, { reviewId: waterCase.ReviewId, decision: 'reject', expectedVersion: ver, reason: 'Listing is misleading to shoppers' });
ok('29 a stale version is refused - no silent overwrite', !res.ok && res.conflict === true && cases().find((c) => c.ReviewId === waterCase.ReviewId).Status === 'CORRECTION_REQUIRED', J(res));

// The seller corrects it -> passes -> published, case closed (history kept).
res = save(S, { productId: waterId, name: 'Drinking water 600ml', description: 'Clean bottled water.', category: 'food', subcategoryId: 'food-bottled-water', requestId: 'req-water-4' });
const closed = cases().find((c) => c.ReviewId === waterCase.ReviewId);
ok('9 corrected by the seller: live again and the case closes itself', res.ok && product(waterId).Status === 'active' && closed.Status === 'CLOSED'
  && closed.ResolutionType === 'SELLER_CORRECTED', J(closed.Status));
ok('20 a resolved case keeps its whole history', JSON.parse(closed.HistoryJson).map((h) => h.to).join('>') === 'PENDING>PENDING>CORRECTION_REQUIRED>CLOSED', closed.HistoryJson);
ok('20 ...and its original snapshot', closed.ProductNameSnapshot === 'Water');

// 15: assign a different existing category.
res = save(S, { name: 'Canned Tuna', description: '', category: 'fashion', subcategoryId: 'fashion-women', submitForReview: true, requestId: 'req-ct-1' });
const ctId = res.productId;
let ctCase = cases().find((c) => c.ProductId === ctId);
res = act(A, { reviewId: ctCase.ReviewId, decision: 'assignCategory', categoryId: 'food', subcategoryId: 'fashion-women', expectedVersion: 1 });
ok('15 assigning a subcategory from another parent is refused', !res.ok);
res = act(A, { reviewId: ctCase.ReviewId, decision: 'assignCategory', categoryId: 'food', subcategoryId: 'food-canned-fish', expectedVersion: 1 });
ok('15 admin assigns Food → Canned Fish & Tuna: checks rerun, listing published', res.ok && res.status === 'APPROVED'
  && product(ctId).Category === 'food' && product(ctId).SubcategoryId === 'food-canned-fish' && product(ctId).Status === 'active', J(res));
ok('Audit: the admin category change is logged', audit().some((a) => a.Action === 'ADMIN_CATEGORY_CHANGE' && a.ActorId === 'own_a'));

// assign that does NOT fix it keeps it held.
res = save(S, { name: 'Water', description: 'Canned tuna in vegetable oil.', category: 'food', subcategoryId: 'food-bottled-water', submitForReview: true, requestId: 'req-w5' });
const w2 = res.productId;
let w2Case = cases().find((c) => c.ProductId === w2);
res = act(A, { reviewId: w2Case.ReviewId, decision: 'assignCategory', categoryId: 'food', subcategoryId: 'food-canned-fish', expectedVersion: 1 });
ok('16 a category change that does not fix the listing keeps it hidden', res.ok && res.stillBlocked && product(w2).Status === 'review' && res.status === 'IN_REVIEW', J(res));

// 17: override needs a reason, is logged, and only clears THIS content.
res = act(A, { reviewId: w2Case.ReviewId, decision: 'override', expectedVersion: 2 });
ok('17 an override without a reason is refused', !res.ok && /reason/.test(res.error));
res = act(A, { reviewId: w2Case.ReviewId, decision: 'override', expectedVersion: 2, reason: 'Seller sells tuna packed in water - checked by phone', requestId: 'adm-ovr-1' });
ok('17 override with a reason: published and audited with the reason', res.ok && product(w2).Status === 'active'
  && audit().some((a) => a.Action === 'OVERRIDE' && /checked by phone/.test(a.Reason)), J(res));
res = save(S, { productId: w2, name: 'Water', description: 'Canned tuna in vegetable oil.', category: 'food', subcategoryId: 'food-canned-fish', variants: [{ label: '24 pack', price: 30 }] });
ok('17 ...a later price change on the same content is not blocked again', res.ok && product(w2).Status === 'active', J(res));
res = save(S, { productId: w2, name: 'Water', description: 'Canned tuna in vegetable oil. Free soap powder.', category: 'food', subcategoryId: 'food-canned-fish' });
ok('17 ...but changing the description is checked from scratch (no global switch-off)', !res.ok && res.needsReview, J(res));
v = check({ name: 'Water', description: 'The cheapest tuna in a can.', categoryId: 'food', subcategoryId: 'food-bottled-water' });
ok('17 ...and the same rule still blocks every other listing', v.blocked);

// Reopen + close.
res = act(A, { reviewId: w2Case.ReviewId, decision: 'reopen', expectedVersion: 3, reason: 'Customer complaint: it is not water' });
ok('Reopen: a decided case goes back to PENDING and the listing is held again', res.ok && res.status === 'PENDING' && product(w2).Status === 'review' && res.heldAgain, J(res));
res = act(A, { reviewId: w2Case.ReviewId, decision: 'reject', expectedVersion: 4, reason: 'Misleading name for canned tuna' });
ok('Reject: listing hidden (not deleted), reason kept', res.ok && product(w2).Status === 'hidden' && cases().find((c) => c.ReviewId === w2Case.ReviewId).ResolutionReason === 'Misleading name for canned tuna');
res = act(A, { reviewId: w2Case.ReviewId, decision: 'close', expectedVersion: 5 });
ok('Close: a decided case can be closed', res.ok && res.status === 'CLOSED');
res = act(A, { reviewId: w2Case.ReviewId, decision: 'approve', expectedVersion: 6 });
ok('19 CLOSED -> APPROVED is not a valid transition', !res.ok && /cannot be moved/.test(res.error), J(res));

// Uncertain (medium) warnings: save anyway -> live + low-priority case.
res = save(S, { name: 'Rice 10kg', description: 'Lovely chocolate', category: 'food', subcategoryId: 'food-rice-grains' });
ok('Uncertain: a one-word clash only warns, and can be saved anyway', !res.ok && res.canSaveAnyway && res.validation.severity === 'medium', J(res));
res = save(S, { name: 'Rice 10kg', description: 'Lovely chocolate', category: 'food', subcategoryId: 'food-rice-grains', acknowledgeWarnings: true });
ok('Uncertain: saved anyway -> live, with a non-blocking case for an admin', res.ok && !res.held && product(res.productId).Status === 'active'
  && cases().some((c) => c.ProductId === res.productId && c.Severity === 'medium' && c.SellerDisputed === 'false'), J(res));
const riceCase = cases().find((c) => c.ProductId === res.productId);
res = act(A, { reviewId: riceCase.ReviewId, decision: 'dismiss', expectedVersion: 1, reason: 'Chocolate is the rice colour, fine' });
ok('6 dismiss a false positive with a documented reason', res.ok && res.status === 'DISMISSED' && audit().some((a) => a.Action === 'DISMISSED_FALSE_POSITIVE'));

/* ---------- 21-26: category requests ---------- */
res = box.actionRequestCategory(S, { proposedName: 'Baby Formula', explanation: 'Powdered milk for babies and toddlers', examples: 'S26 Gold 900g', parentId: 'food', requestId: 'req-cat-1' });
ok('21 a valid category request enters the queue', res.ok && cases().some((c) => c.ReviewId === res.reviewId && c.CaseType === 'CATEGORY_REQUEST' && c.Status === 'PENDING'), J(res));
const babyCase = res.reviewId;
res = box.actionRequestCategory(S, { proposedName: 'Baby Formula', explanation: 'Powdered milk for babies and toddlers', examples: 'S26 Gold 900g', parentId: 'food', requestId: 'req-cat-1' });
ok('10 a retried category request is not created twice', res.replayed && cases().filter((c) => c.ProposedCategoryName === 'Baby Formula').length === 1);
res = box.actionRequestCategory(O, { proposedName: 'Canned fish', explanation: 'Tins of fish from the store', examples: 'Sunbell tuna' });
ok('22 a duplicate of an existing category is flagged', res.ok && res.duplicateOf === 'food-canned-fish' && cases().find((c) => c.ReviewId === res.reviewId).IssueType === 'CATEGORY_REQUEST_DUPLICATE', J(res));
const dupCase = res.reviewId;
res = box.actionRequestCategory(O, { proposedName: 'Stuff', explanation: 'All sorts of stuff I sell', examples: 'things' });
ok('22 an over-broad name is refused', !res.ok && /too broad/.test(res.error));
res = box.actionRequestCategory(O, { proposedName: '<script>x</script>', explanation: 'trying to break the page', examples: 'x y z' });
ok('27 markup in a category name is refused', !res.ok);

res = act(S, { reviewId: babyCase, decision: 'approveCategory', name: 'Baby Formula', parentId: 'food' });
ok('24 a seller cannot approve a category', !res.ok && res.error === 'Not authorized' && !reg().byId['food-baby-formula']);
res = act(A, { reviewId: babyCase, decision: 'approveCategory', name: 'Canned fish', parentId: 'food', expectedVersion: 1 });
ok('23 approving under a duplicate name is refused (merge instead)', !res.ok && /Merge/.test(res.error), J(res));
res = act(A, { reviewId: babyCase, decision: 'approveCategory', name: 'Baby Formula', parentId: 'food', keywords: 'baby formula, infant formula',
  kind: 'baby-food', expectedVersion: 1, requestId: 'adm-cat-1' });
ok('23 admin approves: stable id, in the register, audited', res.ok && res.categoryId === 'food-baby-formula'
  && box.__sheets.Categories.objects().some((c) => c.CategoryId === 'food-baby-formula' && c.CreatedBy === 'own_a' && c.Status === 'active')
  && audit().some((a) => a.Action === 'CATEGORY_APPROVED'), J(res));
const listed = box.actionListCategories();
ok('26 the register refresh shows the new category to sellers', listed.categories.some((c) => c.id === 'food-baby-formula' && c.parentId === 'food'));
res = save(S, { name: 'Infant formula 900g', description: 'Infant formula for 0-6 months', category: 'food', subcategoryId: 'food-baby-formula' });
ok('26 products can use the approved category straight away', res.ok && product(res.productId).SubcategoryId === 'food-baby-formula', J(res));
res = act(A, { reviewId: dupCase, decision: 'reject', expectedVersion: 1, reason: 'Already exists: use Canned Fish & Tuna' });
ok('25 a rejected request keeps the reason', res.ok && cases().find((c) => c.ReviewId === dupCase).ResolutionReason === 'Already exists: use Canned Fish & Tuna');
ok('25 ...and the seller can read it', box.actionListMyReviewCases(O).cases.find((c) => c.reviewId === dupCase).adminMessage === 'Already exists: use Canned Fish & Tuna');

// Register management: switch off, never delete.
res = box.actionAdminSaveCategory(S, { categoryId: 'food-juice', status: 'inactive' });
ok('Register: a seller cannot edit categories', !res.ok && res.error === 'Not authorized');
res = save(S, { name: 'Orange juice 1L', description: 'Fresh juice', category: 'food', subcategoryId: 'food-juice' });
const juiceId = res.productId;
res = box.actionAdminSaveCategory(A, { categoryId: 'food-juice', status: 'inactive' });
ok('Register: admin switches a category off', res.ok && box.__sheets.Categories.objects().find((c) => c.CategoryId === 'food-juice').Status === 'inactive');
res = save(S, { name: 'Apple juice 1L', description: 'Juice', category: 'food', subcategoryId: 'food-juice' });
ok('8 an inactive category cannot be chosen for a new listing', !res.ok && /subcategory/i.test(res.error), J(res));
res = save(S, { productId: juiceId, name: 'Orange juice 1L', description: 'Fresh juice', category: 'food', subcategoryId: 'food-juice', variants: [{ label: '1L', price: 3 }] });
ok('Register: a listing already in it keeps working (not deleted, not blocked)', res.ok && product(juiceId).SubcategoryId === 'food-juice', J(res));
res = box.actionAdminSaveCategory(A, { categoryId: 'food-juice', required: 'colour' });
ok('Register: unknown detail keys are refused', !res.ok && /Unknown detail/.test(res.error));
res = box.actionAdminSaveCategory(A, { categoryId: 'food', name: 'Food' });
ok('Register: top-level names are fixed (they are in the site code)', !res.ok);

/* ---------- 27-31: security and reliability ---------- */
res = save(S, { name: '=HYPERLINK("http://x")', description: '<img src=x onerror=alert(1)>', category: 'home', subcategoryId: 'home-cleaning' });
ok('27 formula / markup input is stored inert (formula escaped)', res.ok && String(product(res.productId).Name).startsWith("'="), J(res));
const longName = 'x'.repeat(151);
res = save(S, { name: longName, description: '', category: 'home' });
ok('27 over-long input is refused', !res.ok);
res = save(S, { name: 'Bleach 1L', description: '', category: 'home', subcategoryId: 'home-cleaning', attributes: { __proto__: 1, volume: { a: 1 }, colour: 'red' } });
ok('27 attribute objects are reduced to known keys', res.ok, J(res));
res = save(O, { productId: tunaId, name: 'Hijack', description: '', category: 'home' });
ok('28 a seller cannot edit another store\'s product', !res.ok && /not found/i.test(res.error) && product(tunaId).Name === 'Tuna in a can');
res = act(A, { reviewId: 'rev_nope', decision: 'approve' });
ok('27 unknown case ids are a plain error', !res.ok && res.error === 'Case not found');
ok('Audit: unauthorised attempts carry no request payload', audit().filter((a) => a.Action === 'UNAUTHORIZED_ATTEMPT').every((a) => !/token|password/i.test(a.NewStateSummary)));
ok('Audit: rows are only ever appended (ids unique)', new Set(audit().map((a) => a.AuditId)).size === audit().length);
const replay = act(A, { reviewId: w2Case.ReviewId, decision: 'override', expectedVersion: 2, reason: 'Seller sells tuna packed in water - checked by phone', requestId: 'adm-ovr-1' });
ok('10 a retried admin action is answered from the first result (no second override)', replay.replayed === true
  && audit().filter((a) => a.Action === 'OVERRIDE').length === 1);

// Inventory import: an imported name in the wrong category is created held.
const ctx = { variants: [], variantsSheet: box.__sheets.Variants };
const out = box.applyImportPlan(S, { updates: [], newProducts: [
  { name: 'Canned tuna 185g', category: 'fashion', items: [{ line: 2, fields: { variantLabel: 'Tin', price: 3 } }] },
  { name: 'Summer dress', category: 'fashion', items: [{ line: 3, fields: { variantLabel: 'M', price: 20 } }] }] }, ctx, { source: 'csv', syncId: 's1' });
const imported = products().filter((p) => /^(Canned tuna 185g|Summer dress)$/.test(p.Name));
ok('Import: a mismatched new product is held with a case, a fitting one goes live', out.held === 1
  && imported.find((p) => p.Name === 'Canned tuna 185g').Status === 'review' && imported.find((p) => p.Name === 'Summer dress').Status === 'active', J(out));

// 31: an existing product (legacy category, no subcategory) still saves.
res = save(S, { productId: 'prod_old', name: 'Old soap', description: '', category: 'household', variants: [{ variantId: 'var_old', label: 'Bar', price: 2 }] });
ok('31 a legacy listing (old category value) still saves', res.ok && product('prod_old').Category === 'home', J(res));
ok('31 the seller product list carries the review state', box.actionListOwnerProducts(S, { limit: 50 }).products.find((p) => p.productId === w2).review.status === 'CLOSED');

// 31: a listing saved before types were enforced (a service in Handicrafts,
// which only takes products) keeps saving; a NEW one like it is refused.
box.__sheets.Products.grid.push(['prod_svc', 'own_s', 'shop', 'Weaving lessons', '', 'handicrafts', 'service', '', '', '', '', 'active', 0, '', '']);
res = save(S, { productId: 'prod_svc', name: 'Weaving lessons', description: '', category: 'handicrafts', listingType: 'service' });
ok('31 an older listing whose type the category no longer takes still saves', res.ok, J(res));
res = save(S, { name: 'Carving lessons', description: '', category: 'handicrafts', listingType: 'service' });
ok('31 ...but a new one is refused', !res.ok && /does not take services/.test(res.error), J(res));

/* ---------- one engine, both sides ---------- */
const gs = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/ListingRules.gs', 'utf8');
const fe = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/listing-rules.js', 'utf8');
ok('The seller form runs the SAME rules file as the backend (built copy is current)', fe.endsWith(gs));

let fails = 0;
console.log('\n--- listing checks + review queue ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
