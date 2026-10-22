/**
 * Product details by category, and likely-duplicate checks (Oct 2026).
 *
 * Details are short, optional facts a seller adds for their kind of listing:
 * weight and best-before for food, brand and warranty for electronics,
 * species and fresh/frozen for fish, service area for a service, and so on.
 * They are stored in Products.AttributesJson (added on first use) as
 * { key: value }, limited to the keys below, each a short string or one of a
 * fixed list. Nothing is invented: a key the seller left blank is simply not
 * there. Shoppers see them as a small "Details" list (label + value).
 *
 * The form decides WHICH keys to offer per category (owner-product-steps.js,
 * PRODUCT_DETAIL_SETS there) - the server only checks keys and values, so a
 * category can be given more fields without a backend change.
 *
 * volume, netQuantity, size and material are the same keys the listing checks
 * look for (ListingRules.gs LISTING_ATTRIBUTES), so filling them in here also
 * answers those tips.
 */

var PRODUCT_DETAIL_FIELDS = {
  netQuantity: { label: 'Weight / size of pack', max: 40 },
  volume: { label: 'Volume', max: 40 },
  unitOfSale: { label: 'Sold by', max: 30 },
  bestBefore: { label: 'Best before', max: 30 },
  storage: { label: 'Storage', options: ['Room temperature', 'Keep cool', 'Chilled', 'Frozen'] },
  brand: { label: 'Brand', max: 40 },
  model: { label: 'Model', max: 40 },
  condition: { label: 'Condition', options: ['New', 'Used - like new', 'Used - good', 'Used - fair', 'For parts'] },
  warranty: { label: 'Warranty', max: 60 },
  size: { label: 'Size', max: 40 },
  colour: { label: 'Colour', max: 40 },
  material: { label: 'Material', max: 40 },
  dimensions: { label: 'Dimensions', max: 60 },
  species: { label: 'Species', max: 40 },
  freshness: { label: 'Fresh or frozen', options: ['Fresh', 'Frozen', 'Dried', 'Smoked', 'Salted'] },
  deliveryNote: { label: 'Delivery needs', max: 120 },
  serviceArea: { label: 'Service area', max: 80 },
  duration: { label: 'Duration', max: 40 },
  pricingModel: { label: 'Priced', options: ['Fixed price', 'Per hour', 'Per day', 'Per job', 'By quote'] },
  deposit: { label: 'Deposit', max: 30 },
  bookingNotes: { label: 'Booking notes', max: 120 },
  availability: { label: 'Availability', options: ['Ready now', 'Ready in 1-2 days', 'Ready in 3-7 days', 'Made to order'] }
};
var PRODUCT_DETAIL_ORDER = Object.keys(PRODUCT_DETAIL_FIELDS);

/**
 * The details a browser sent, cleaned: known keys only, trimmed, control
 * characters removed, length-capped, list values exact. Returns
 * { details } or { error } (an unknown list value is refused rather than
 * stored as typed, so shoppers never see a value the form never offered).
 */
function cleanProductDetails(raw) {
  var out = {};
  if (raw === undefined || raw === null) return { details: out };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Details were not in the expected form.' };
  var keys = Object.keys(raw);
  if (keys.length > 40) return { error: 'Too many details.' };
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var def = PRODUCT_DETAIL_FIELDS[k];
    if (!def) continue;   // an older or newer form's key: ignored, never stored
    var v = String(raw[k] == null ? '' : raw[k]).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    if (def.options) {
      if (def.options.indexOf(v) === -1) return { error: def.label + ': choose one of the options given.' };
    } else if (v.length > def.max) {
      return { error: def.label + ': keep it to ' + def.max + ' characters.' };
    }
    out[k] = v;
  }
  return { details: out };
}

/** Stored details as { key: value } (known keys only). */
function productDetailsMapOf(p) {
  var raw = parseJsonSafe(p && p.AttributesJson, {});
  var cleaned = cleanProductDetails(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  return cleaned.details || {};
}

/** What shoppers get: [{ key, label, value }] in a fixed order. */
function productDetailsListOf(p) {
  var map = productDetailsMapOf(p);
  return PRODUCT_DETAIL_ORDER.filter(function (k) { return map[k]; })
    .map(function (k) { return { key: k, label: PRODUCT_DETAIL_FIELDS[k].label, value: map[k] }; });
}

/**
 * Details as the listing checks read them. "Weight / size of pack" holding a
 * volume (600ml, 1.5L) also answers the volume tip for drinks.
 */
function listingAttributesFromDetails(details, extra) {
  var out = {};
  Object.keys(details || {}).forEach(function (k) { out[k] = details[k]; });
  if (out.netQuantity && !out.volume && LISTING_ATTRIBUTES.volume.re.test(String(out.netQuantity).toLowerCase())) out.volume = out.netQuantity;
  if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

/* ==================== Likely duplicates ==================== */

// Sizes and quantities: "600ml" and "1.5L" water are different products.
var DUP_QTY_RE = /\b\d+(?:\.\d+)?\s?(?:ml|l|lt|ltr|litre|litres|g|gm|kg|kgs|oz|lb|lbs|pack|pk|pcs|pieces|x|inch|in|cm|mm|m|w|watt|watts|v|ah|mah|gb|tb)\b/g;
var DUP_STOP = { the: 1, a: 1, an: 1, and: 1, of: 1, for: 1, with: 1, in: 1, new: 1, sale: 1, best: 1, good: 1, quality: 1 };

function dupNormalize(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function dupWords(s) {
  return dupNormalize(s).replace(DUP_QTY_RE, ' ').split(' ').filter(function (w) { return w && w.length > 1 && !DUP_STOP[w] && !/^\d+(\.\d+)?$/.test(w); });
}
function dupQuantities(s) {
  return (dupNormalize(s).match(DUP_QTY_RE) || []).map(function (q) { return q.replace(/\s/g, ''); }).sort().join(',');
}

/**
 * How alike two listings are, 0..1, by their words (Jaccard), or 0 when they
 * plainly differ: another category, or different sizes/quantities in the name
 * ("Rice 1kg" vs "Rice 25kg" are not duplicates).
 */
function duplicateScore(a, b) {
  if (a.category && b.category && a.category !== b.category) return 0;
  var qa = dupQuantities(a.name), qb = dupQuantities(b.name);
  if (qa && qb && qa !== qb) return 0;
  var wa = dupWords(a.name), wb = dupWords(b.name);
  if (!wa.length || !wb.length) return 0;
  var set = {}, inter = 0, union = {};
  wa.forEach(function (w) { set[w] = true; union[w] = true; });
  wb.forEach(function (w) { if (set[w]) { inter++; set[w] = false; } union[w] = true; });
  var n = Object.keys(union).length;
  var score = n ? inter / n : 0;
  if (a.brand && b.brand && dupNormalize(a.brand) !== dupNormalize(b.brand)) score *= 0.5;
  if (a.model && b.model && dupNormalize(a.model) !== dupNormalize(b.model)) return 0;
  return score;
}

/**
 * The seller's own listings that look like the one being written (not
 * archived, not the listing itself). body: { name, category, productId?,
 * details? }. At most 3, best match first. Advice only - never blocks a save.
 */
function actionFindSimilarProducts(owner, body) {
  body = body || {};
  var name = String(body.name || '').trim().slice(0, 150);
  if (dupWords(name).length === 0) return ok({ similar: [] });
  var details = cleanProductDetails(body.details).details || {};
  var me = { name: name, category: String(body.category || ''), brand: details.brand || '', model: details.model || '' };
  var self = String(body.productId || '');
  var list = sheetToObjects(getSheet('Products')).filter(function (p) {
    return p.OwnerId === owner.OwnerId && p.ProductId !== self && p.Status !== 'archived';
  });
  var scored = list.map(function (p) {
    var d = productDetailsMapOf(p);
    return { p: p, score: duplicateScore(me, { name: p.Name, category: categoryIdOf(p.Category), brand: d.brand || '', model: d.model || '' }) };
  }).filter(function (x) { return x.score >= 0.75; })
    .sort(function (x, y) { return y.score - x.score; }).slice(0, 3);
  return ok({ similar: scored.map(function (x) {
    return { productId: x.p.ProductId, name: x.p.Name, status: x.p.Status, imageUrl: x.p.ImageUrl || '' };
  }) });
}
