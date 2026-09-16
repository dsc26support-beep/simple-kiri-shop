// The category/listing-type split, run against the REAL sources.
//
// The migration's whole safety argument is that nothing rewrites a stored row:
// legacy values are mapped on read. So the thing to prove is that every legacy
// value still lands somewhere sensible, and - the dangerous one - that a legacy
// rental is still treated as a rental even though its mapped category is now
// 'other'.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

// --- frontend taxonomy ---
const fe = {};
vm.createContext(fe);
const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const grab = (re) => (helpers.match(re) || [''])[0];
vm.runInContext([
  grab(/const LISTING_TYPES = \[[\s\S]*?\n\];/),
  grab(/const ALL_TYPES = [^\n]*/),
  grab(/const CATEGORIES = \[[\s\S]*?\n\];/),
  grab(/const LEGACY_CATEGORY_MAP = \{[\s\S]*?\n\};/),
  grab(/const LEGACY_NEEDS_REVIEW = [^\n]*/),
  grab(/function categoryById[\s\S]*?\n}/),
  grab(/function activeCategories[\s\S]*?\n}/),
  grab(/function popularCategories[\s\S]*?\n}/),
  grab(/function categoryIdOf[\s\S]*?\n}/),
  grab(/function categoryLabelOf[\s\S]*?\n}/),
  grab(/function listingTypeOf[\s\S]*?\n}/),
  grab(/function isBookingListing[\s\S]*?\n}/),
  // `const` bindings do not become properties of a vm context the way function
  // declarations do, so the constants are handed out explicitly.
  'this.CATEGORIES = CATEGORIES; this.LISTING_TYPES = LISTING_TYPES;' +
  'this.LEGACY_CATEGORY_MAP = LEGACY_CATEGORY_MAP; this.LEGACY_NEEDS_REVIEW = LEGACY_NEEDS_REVIEW;'
].join('\n'), fe);

// --- backend taxonomy ---
const be = { Object: Object, String: String };
vm.createContext(be);
const prod = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const grabB = (re) => (prod.match(re) || [''])[0];
vm.runInContext([
  grabB(/var LISTING_TYPE_IDS = [^\n]*/),
  grabB(/var CATEGORY_IDS = \[[\s\S]*?\];/),
  grabB(/var LEGACY_CATEGORY_MAP = \{[\s\S]*?\n\};/),
  grabB(/function categoryIdOf[\s\S]*?\n}/),
  grabB(/function listingTypeOfRow[\s\S]*?\n}/),
  grabB(/function isBookingRow[\s\S]*?\n}/),
  grabB(/function listingTypeOf\(p\)[\s\S]*?\n}/)
].join('\n'), be);

/* ---------- the primary categories ---------- */
// Handicrafts & Souvenirs added after Agriculture, deliberately adjacent: the
// shopper after a pandanus mat and the one after local produce are often the
// same person. Everything below it shifted one place - order is a display sort
// key only, never stored on a row, so renumbering rewrites nothing.
const SPEC = ['Food & Groceries', 'Fashion & Beauty', 'Electronics & Phones', 'Home & Living',
  'Building & Hardware', 'Vehicles & Transport', 'Fishing & Marine', 'Agriculture & Local Products',
  'Handicrafts & Souvenirs',
  'Property & Accommodation', 'Services', 'Education & Jobs', 'Events & Travel',
  'Everything Solar', 'Hire', 'Rental'];
const labels = fe.activeCategories().map((c) => c.label);
ok('every primary category exists, in order',
  JSON.stringify(labels.slice(0, SPEC.length)) === JSON.stringify(SPEC), JSON.stringify(labels));
ok('Other is last, and the only one past the spec list',
  labels[SPEC.length] === 'Other' && labels.length === SPEC.length + 1, JSON.stringify(labels));

/* ---------- Rental is a category now, and still a listing type ---------- */
// These were one thing and are now two, which is exactly the confusion the
// original 'rentals' category caused. What makes it safe is that they live in
// different namespaces and neither reads the other's ids: a row carries BOTH a
// Category and a ListingType, and listingTypeOf() never consults the category
// except for the legacy values below.
ok('there is a Rental category and a rental listing type, and they are separate',
  fe.CATEGORIES.some((c) => c.id === 'rental') &&
  fe.LISTING_TYPES.some((t) => t.id === 'rental'));
ok('the Rental category only accepts rentals',
  JSON.stringify(fe.categoryById('rental').types) === '["rental"]');
ok('Hire accepts rentals and services, which is what tells it from Rental',
  JSON.stringify(fe.categoryById('hire').types) === '["rental","service"]');
ok('a product filed under Rental is still typed by its listing type, not its category',
  fe.listingTypeOf({ category: 'rental', listingType: 'product' }) === 'product');
ok("legacy 'rentals' still goes to Other, NOT to the new Rental category",
  fe.categoryIdOf('rentals') === 'other' && fe.categoryIdOf('rentals') === be.categoryIdOf('rentals'));

ok('the homepage strip stays a scrolling row, so its length is not capped',
  fe.popularCategories().length >= 5, String(fe.popularCategories().length));
ok('Other is never "popular"', !fe.popularCategories().some((c) => c.id === 'other'));

/* ---------- Featured is a view, not a category ---------- */
// The safety argument for the browse rail's first entry. If 'featured' ever
// becomes a storable id, a seller can file themselves at the top of the rail,
// which is the one thing the admin-curated Featured sheet exists to prevent.
const featuredView = (helpers.match(/const FEATURED_VIEW = \{[^}]*\};/) || [''])[0];
ok('FEATURED_VIEW exists and names the rail entry',
  /id:\s*'featured'/.test(featuredView) && /label:\s*'Featured'/.test(featuredView), featuredView);
ok('featured is NOT a category on the frontend',
  !fe.CATEGORIES.some((c) => c.id === 'featured'), JSON.stringify(fe.CATEGORIES.map((c) => c.id)));
ok('featured is NOT a storable id on the backend',
  be.CATEGORY_IDS.indexOf('featured') === -1, JSON.stringify(be.CATEGORY_IDS));
ok('a row claiming category=featured lands in Other on BOTH sides',
  fe.categoryIdOf('featured') === 'other' && be.categoryIdOf('featured') === 'other',
  fe.categoryIdOf('featured') + ' / ' + be.categoryIdOf('featured'));

/* ---------- Other is off the seller's form, on the shopper's rail ---------- */
const ownerProducts = fs.readFileSync(REPO + 'assets/js/owner-products.js', 'utf8');
ok('Other is still active, so a shopper can still browse what is in it',
  fe.categoryById('other').active === true);
ok('the seller form no longer force-includes Other',
  !/c\.id === 'other' \|\|/.test(ownerProducts), 'the old force-include is still there');
ok('the seller form offers Other back only to a listing already filed in it',
  /c\.id === 'other' \? keepId === 'other'/.test(ownerProducts));
ok('every category carries the fields the spec asks for',
  fe.CATEGORIES.every((c) => c.id && c.label && typeof c.order === 'number' &&
    typeof c.active === 'boolean' && Array.isArray(c.types)),
  JSON.stringify(fe.CATEGORIES[0]));
ok('no duplicate category ids',
  new Set(fe.CATEGORIES.map((c) => c.id)).size === fe.CATEGORIES.length);
ok('three listing types: product, rental, service',
  JSON.stringify(fe.LISTING_TYPES.map((t) => t.id)) === '["product","rental","service"]');

/* ---------- frontend and backend agree ---------- */
ok('frontend and backend category ids match exactly',
  JSON.stringify(fe.CATEGORIES.map((c) => c.id)) === JSON.stringify(be.CATEGORY_IDS),
  JSON.stringify(be.CATEGORY_IDS));
ok('frontend and backend legacy maps match exactly',
  JSON.stringify(fe.LEGACY_CATEGORY_MAP) === JSON.stringify(be.LEGACY_CATEGORY_MAP),
  JSON.stringify(be.LEGACY_CATEGORY_MAP));
ok('frontend and backend listing types match',
  JSON.stringify(fe.LISTING_TYPES.map((t) => t.id)) === JSON.stringify(be.LISTING_TYPE_IDS));

/* ---------- migration: every legacy value lands somewhere ---------- */
const LEGACY = ['pantry', 'clothing', 'household', 'electronics', 'rentals', 'services', 'general', ''];
for (const old of LEGACY) {
  const mapped = fe.categoryIdOf(old);
  ok(`legacy '${old || '(blank)'}' maps to a real category`, !!fe.categoryById(mapped), mapped);
  ok(`  and frontend/backend map it identically`, mapped === be.categoryIdOf(old),
    `${mapped} vs ${be.categoryIdOf(old)}`);
}
ok("legacy 'pantry' becomes Food & Groceries", fe.categoryLabelOf('pantry') === 'Food & Groceries');
ok("legacy 'clothing' becomes Fashion & Beauty", fe.categoryLabelOf('clothing') === 'Fashion & Beauty');
ok("legacy 'household' becomes Home & Living", fe.categoryLabelOf('household') === 'Home & Living');
ok("legacy 'electronics' keeps its slug", fe.categoryIdOf('electronics') === 'electronics');
ok("legacy 'services' stays in Services", fe.categoryIdOf('services') === 'services');
ok("legacy 'rentals' cannot be filed confidently, so it goes to Other",
  fe.categoryIdOf('rentals') === 'other');
ok("legacy 'general' goes to Other", fe.categoryIdOf('general') === 'other');
ok('an unknown value goes to Other, never blank', fe.categoryIdOf('nonsense-xyz') === 'other');
ok('the values needing admin review are named', 
  JSON.stringify(fe.LEGACY_NEEDS_REVIEW) === JSON.stringify(['rentals', 'general', '']),
  JSON.stringify(fe.LEGACY_NEEDS_REVIEW));

/* ---------- THE DANGEROUS ONE: a legacy rental must still be a rental ---------- */
const legacyRental = { category: 'rentals', name: 'Kayak' };
const legacyService = { category: 'services', name: 'Car wash' };
const legacyGoods = { category: 'pantry', name: 'Rice' };
ok('a legacy rental is still typed as a rental', fe.listingTypeOf(legacyRental) === 'rental');
ok('a legacy service is still typed as a service', fe.listingTypeOf(legacyService) === 'service');
ok('legacy goods are still products', fe.listingTypeOf(legacyGoods) === 'product');
ok('a legacy rental still gets the date-request flow, NOT the cart',
  fe.isBookingListing(legacyRental) === true);
ok('a legacy service still gets the date-request flow', fe.isBookingListing(legacyService) === true);
ok('goods still go to the cart', fe.isBookingListing(legacyGoods) === false);
ok('...even though its mapped category is now Other, which the OLD check would have missed',
  fe.categoryIdOf(legacyRental.category) === 'other' && fe.isBookingListing(legacyRental) === true);

// Sheet-row shape, backend side.
ok('backend: legacy rental row types as rental',
  be.listingTypeOfRow({ Category: 'rentals', ListingType: '' }) === 'rental');
ok('backend: legacy service row types as service',
  be.listingTypeOfRow({ Category: 'services', ListingType: '' }) === 'service');
ok('backend: a legacy rental row still books', be.isBookingRow({ Category: 'rentals' }) === true);

/* ---------- an explicit type always wins ---------- */
ok('an explicit type beats the legacy category',
  fe.listingTypeOf({ category: 'rentals', listingType: 'product' }) === 'product');
ok('a rental filed under Vehicles is a rental',
  fe.listingTypeOf({ category: 'vehicles', listingType: 'rental' }) === 'rental');
ok('a product filed under Vehicles is a product - one category, several types',
  fe.listingTypeOf({ category: 'vehicles', listingType: 'product' }) === 'product');
ok('a service filed under Vehicles is a service',
  fe.listingTypeOf({ category: 'vehicles', listingType: 'service' }) === 'service');
ok('a nonsense type falls back rather than throwing',
  fe.listingTypeOf({ category: 'vehicles', listingType: 'rubbish' }) === 'product');
ok('backend agrees an explicit type wins',
  be.listingTypeOfRow({ Category: 'rentals', ListingType: 'product' }) === 'product');

/* ---------- seller narrowing ---------- */
ok('every listing type has at least one category that accepts it',
  ['product', 'rental', 'service'].every((t) => fe.CATEGORIES.some((c) => c.types.indexOf(t) !== -1)));
ok('Other accepts every listing type, so nothing is un-fileable',
  ['product', 'rental', 'service'].every((t) => fe.categoryById('other').types.indexOf(t) !== -1));
ok('Vehicles & Transport accepts products, rentals AND services - the spec example',
  ['product', 'rental', 'service'].every((t) => fe.categoryById('vehicles').types.indexOf(t) !== -1));

/* ---------- APP_VERSION ---------- */
const { execSync } = require('child_process');
const verOf = (src) => (src.match(/APP_VERSION = '([^']+)'/) || [])[1];
let anyGs = false;
for (const f of fs.readdirSync(REPO + 'apps-script')) {
  if (!f.endsWith('.gs')) continue;
  let base = '';
  try { base = execSync(`git -C ${REPO} show origin/main:apps-script/${f}`).toString(); } catch (e) { base = ''; }
  if (fs.readFileSync(REPO + 'apps-script/' + f, 'utf8') !== base) anyGs = true;
}
const cur = verOf(fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8'));
const mainVer = verOf(execSync(`git -C ${REPO} show origin/main:apps-script/Code.gs`).toString());
ok('an Apps Script change bumps APP_VERSION', !anyGs || cur !== mainVer, `${mainVer} -> ${cur}`);

let f = 0;
console.log('\n--- Category / listing-type taxonomy and migration ---');
for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
