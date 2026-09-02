/**
 * Product reviews and ratings.
 *
 * Ratings are the input that makes "Best Value", "Highest rated" and the
 * product page's decision support honest - without them any such ranking
 * collapses into "cheapest", which is exactly what it must not be. So the
 * rules here are deliberately strict about who may write one:
 *
 *   - A review requires a signed-in customer (requireCustomerAuth). Sellers
 *     never write to this sheet, and nothing a seller submits anywhere can
 *     influence a rating - the aggregate is computed here, server-side, from
 *     rows only customers can create.
 *   - One review per customer per product, enforced on write.
 *   - VerifiedPurchase is derived, never submitted: it is true only when an
 *     Order exists for that customer's email containing that product.
 *
 * REQUIRES a Reviews tab (created by setupSheets) with this header row:
 *   Reviews: ReviewId | ProductId | OwnerId | StoreSlug | CustomerId |
 *            CustomerName | Rating | Comment | VerifiedPurchase | Status |
 *            CreatedAt | UpdatedAt
 *
 * Every read path tolerates the tab being absent, so a deployment that has
 * not run setupSheets yet keeps working exactly as it did before.
 */

var REVIEW_COMMENT_MAX = 1000;
var REVIEW_VALID_STATUSES = ['published', 'hidden'];

/**
 * {productId: {average, count}} over published reviews.
 *
 * Returns {} when the tab does not exist. That matters: search and the
 * product listing call this on every request, and a missing tab must degrade
 * to "no ratings yet" rather than breaking browsing for the whole site.
 */
function productRatingIndex() {
  var rows;
  try {
    rows = sheetToObjects(getSheet('Reviews'));
  } catch (err) {
    return {};
  }

  var totals = {};
  rows.forEach(function (r) {
    if (String(r.Status) !== 'published') return;
    var pid = String(r.ProductId || '');
    var rating = Number(r.Rating);
    if (!pid || !(rating >= 1 && rating <= 5)) return;
    if (!totals[pid]) totals[pid] = { sum: 0, count: 0 };
    totals[pid].sum += rating;
    totals[pid].count += 1;
  });

  var index = {};
  Object.keys(totals).forEach(function (pid) {
    index[pid] = {
      // One decimal is all the precision a star display can honestly show.
      average: Math.round((totals[pid].sum / totals[pid].count) * 10) / 10,
      count: totals[pid].count
    };
  });
  return index;
}

/** Has this customer already bought this product? Drives VerifiedPurchase. */
function customerBoughtProduct(customerEmail, productId) {
  var email = normalizeEmail(customerEmail);
  if (!email) return false;
  var orders;
  try {
    orders = sheetToObjects(getSheet('Orders'));
  } catch (err) {
    return false;
  }
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (normalizeEmail(o.CustomerEmail) !== email) continue;
    if (String(o.Status) === 'Cancelled') continue;
    // ItemsJson is the authoritative line-item record written by
    // actionCreateOrder; a substring test on the product id is enough to say
    // "this order contained it" without re-parsing every order's JSON.
    if (String(o.ItemsJson || '').indexOf(productId) !== -1) return true;
  }
  return false;
}

function publicReviewFields(r) {
  return {
    reviewId: r.ReviewId,
    productId: r.ProductId,
    customerName: r.CustomerName,
    rating: Number(r.Rating),
    comment: r.Comment,
    verifiedPurchase: String(r.VerifiedPurchase) === 'true',
    createdAt: r.CreatedAt
  };
}

/* ---------- Actions ---------- */

/**
 * Public read: every published review for one product, newest first, plus the
 * aggregate and the 1-5 star distribution the product page renders.
 */
function actionListProductReviews(params) {
  var productId = String(params.productId || '').trim();
  if (!productId) return fail('Missing productId');

  var rows;
  try {
    rows = sheetToObjects(getSheet('Reviews'));
  } catch (err) {
    // No tab yet - an empty, valid answer beats an error the caller has to
    // special-case.
    return ok({ reviews: [], average: null, count: 0, distribution: [0, 0, 0, 0, 0] });
  }

  var mine = rows.filter(function (r) {
    return String(r.ProductId) === productId && String(r.Status) === 'published';
  });

  var distribution = [0, 0, 0, 0, 0];
  var sum = 0;
  mine.forEach(function (r) {
    var rating = Number(r.Rating);
    if (rating >= 1 && rating <= 5) {
      distribution[rating - 1] += 1;
      sum += rating;
    }
  });

  mine.sort(function (a, b) {
    return new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime();
  });

  return ok({
    reviews: mine.slice(0, 50).map(publicReviewFields),
    average: mine.length ? Math.round((sum / mine.length) * 10) / 10 : null,
    count: mine.length,
    distribution: distribution
  });
}

/**
 * Customer-authenticated write. Rating and VerifiedPurchase are both settled
 * server-side; nothing the client sends can set a verified badge or influence
 * another product's aggregate.
 */
function actionSubmitReview(body) {
  var customer;
  try {
    customer = requireCustomerAuth(body.token);
  } catch (err) {
    return fail(err.message || 'Please sign in to leave a review');
  }

  var productId = String(body.productId || '').trim();
  if (!productId) return fail('Missing productId');

  var rating = Number(body.rating);
  if (!(rating >= 1 && rating <= 5) || rating !== Math.round(rating)) {
    return fail('Please choose a rating from 1 to 5 stars');
  }

  var comment = String(body.comment || '').trim();
  var commentErr = capLength(comment, REVIEW_COMMENT_MAX, 'Review');
  if (commentErr) return commentErr;

  var product = findRowById(getSheet('Products'), 'ProductId', productId);
  if (!product || String(product.Status) !== 'active') {
    return fail('That product is no longer available');
  }
  var owner = findRowById(getSheet('Owners'), 'OwnerId', product.OwnerId);
  if (!owner) return fail('That product is no longer available');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('Reviews');

    // One per customer per product. Checked inside the lock so two rapid
    // submits cannot both pass.
    var existing = sheetToObjects(sheet).filter(function (r) {
      return String(r.ProductId) === productId && String(r.CustomerId) === String(customer.CustomerId);
    })[0];
    if (existing) {
      return fail('You have already reviewed this product');
    }

    appendRowFromObject(sheet, {
      ReviewId: newId('rev'),
      ProductId: productId,
      OwnerId: product.OwnerId,
      StoreSlug: owner.StoreSlug,
      CustomerId: customer.CustomerId,
      CustomerName: customer.Name,
      Rating: rating,
      Comment: comment,
      VerifiedPurchase: customerBoughtProduct(customer.Email, productId) ? 'true' : 'false',
      Status: 'published',
      CreatedAt: nowIso(),
      UpdatedAt: nowIso()
    });
  } finally {
    lock.releaseLock();
  }

  return ok({ submitted: true });
}
