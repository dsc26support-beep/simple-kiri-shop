/**
 * Test products for one store (owner request, 28 Oct 2026): 150 listings
 * spread over every category, in the store "Nei Recharge", for testing the
 * site with a fuller catalogue.
 *
 * Run from the Apps Script editor (choose the function, press Run):
 *   addTestProducts()     adds them - safe to run again: it only tops up to
 *                         150, so if Apps Script stops it at its time limit,
 *                         run it again and it carries on.
 *   removeTestProducts()  removes exactly these again (and nothing else) -
 *                         the normal product delete, which archives them:
 *                         gone from the site and the dashboard.
 *
 * Every test listing's name starts "TEST - " and its description carries
 * TEST_DATA_TAG; removal needs both, so it can never touch a real product.
 * Listings go through the normal seller save (actionCreateOrUpdateProduct):
 * the same checks, stock ledger, audit and till (POS) updates as a real one.
 * Nothing here is reachable from the website - only from the editor.
 */
var TEST_DATA_STORE_NAME = 'Nei Recharge';
var TEST_DATA_TOTAL = 150;
var TEST_DATA_TAG = '[mwk-test-2026-10]';
var TEST_DATA_PREFIX = 'TEST - ';
var TEST_DATA_SECONDS = 270;   // stop before Apps Script's 6-minute limit

// Realistic names per category, so the listing checks (which compare name and
// category) accept them. 'other' takes no new listings and is left out.
var TEST_DATA_ITEMS = {
  food: ['Rice 10kg bag', 'Sugar 2kg', 'Flour 10kg', 'Tinned tuna 185g', 'Corned beef 340g', 'Instant noodles 5 pack', 'Coconut oil 1L', 'Biscuits pack', 'Powdered milk 400g', 'Cooking oil 2L'],
  fashion: ['Island print dress', 'Lavalava wrap', 'Men\'s aloha shirt', 'Flip flops', 'School uniform shirt', 'Hair flower clip', 'Body lotion 250ml', 'Sun hat', 'Cotton T-shirt', 'Shoulder bag'],
  electronics: ['Mobile phone charger', 'USB-C cable 1m', 'Bluetooth speaker', 'Earphones', 'Power bank 10000mAh', 'Phone case', 'Memory card 32GB', 'Radio with torch', 'Extension cord', 'LED desk lamp'],
  home: ['Plastic water bucket', 'Cooking pot 5L', 'Frying pan', 'Mosquito net', 'Bed sheet set', 'Plastic chair', 'Water container 20L', 'Kitchen knife', 'Broom', 'Food storage box'],
  building: ['Roofing iron sheet', 'Box of nails 1kg', 'Cement bag 40kg', 'Timber plank 2.4m', 'Paint 4L white', 'Hammer', 'Hand saw', 'PVC pipe 3m', 'Door hinge pair', 'Padlock'],
  vehicles: ['Motorbike helmet', 'Bicycle tyre', 'Engine oil 1L', 'Motorbike chain', 'Bicycle pump', 'Spark plug', 'Car battery', 'Brake pads', 'Outboard fuel tank', 'Tyre repair kit'],
  fishing: ['Fishing line 100m', 'Fish hooks pack', 'Fishing lure', 'Snorkel mask', 'Fishing net', 'Canoe paddle', 'Fishing sinkers', 'Cool box', 'Spear gun rubber', 'Fishing rod'],
  agriculture: ['Breadfruit', 'Pandanus fruit', 'Coconut seedlings', 'Babai (giant taro)', 'Garden hoe', 'Vegetable seeds pack', 'Compost bag', 'Watering can', 'Toddy (karewe) 1L', 'Banana bunch'],
  handicrafts: ['Pandanus mat', 'Woven fan', 'Shell necklace', 'Model canoe', 'Woven basket', 'Carved wooden turtle', 'Woven hat', 'Shark tooth necklace', 'Wall hanging', 'Woven purse'],
  property: ['Room for rent in Bairiki', 'House for rent in Bikenibeu', 'Guest room by the lagoon', 'Studio flat in Betio', 'Family house in Teaoraereke', 'Shop space for rent', 'Room near the hospital', 'Holiday house on Abaiang', 'Office space in Bairiki', 'Two-bedroom house'],
  services: ['House cleaning', 'Phone screen repair', 'Hair cutting', 'Sewing and alterations', 'Laundry service', 'Garden clearing', 'Computer repair', 'Small engine repair', 'Typing and printing', 'Photography'],
  education: ['Maths tutoring', 'English lessons', 'Computer lessons', 'Guitar lessons', 'Sewing class', 'Driving lessons', 'Swimming lessons', 'Homework help', 'Kiribati language lessons', 'Cooking class'],
  events: ['Party tent', 'Sound system', 'Wedding decorations', 'Party balloons', 'Event stage hire', 'Event ticket', 'Island tour', 'Wedding planning', 'Catering for 50', 'Dance group booking'],
  solar: ['Solar panel 100W', 'Solar lantern', 'Solar battery 100Ah', 'Charge controller', 'Solar fan', 'Solar phone charger', 'Inverter 1000W', 'Solar light bulb kit', 'Solar water pump', 'Solar cable 10m'],
  hire: ['Truck hire', 'Boat hire', 'Generator hire', 'Concrete mixer hire', 'Car hire', 'Motorbike hire', 'Ladder hire', 'Canoe hire', 'Tent hire', 'Water pump hire'],
  rental: ['Car rental', 'Motorbike rental', 'Bicycle rental', 'Kayak rental', 'Generator rental', 'Projector rental', 'Snorkel set rental', 'Cool box rental', 'Speaker rental', 'Tent rental']
};

function testDataStore_() {
  var owners = sheetToObjects(getSheet('Owners')).filter(function (o) {
    return String(o.StoreName || '').trim().toLowerCase() === TEST_DATA_STORE_NAME.toLowerCase();
  });
  if (owners.length !== 1) {
    throw new Error(owners.length ? 'More than one store is called "' + TEST_DATA_STORE_NAME + '" - nothing done.'
      : 'No store is called "' + TEST_DATA_STORE_NAME + '" - nothing done. Check TEST_DATA_STORE_NAME at the top of TestData.gs.');
  }
  return owners[0];
}

/** One of this store's test listings that is still there (delete archives a product). */
function isTestProduct_(p, owner) {
  return p.OwnerId === owner.OwnerId && String(p.Status) !== 'archived' && String(p.Name || '').indexOf(TEST_DATA_PREFIX) === 0
    && String(p.Description || '').indexOf(TEST_DATA_TAG) !== -1;
}

/** The listing type a category takes: product where allowed, else rental, else service. */
function testDataType_(categoryId) {
  var cat = LISTING_CATEGORY_SEED.filter(function (c) { return c.id === categoryId && !c.parentId; })[0];
  var types = cat && cat.types ? cat.types : null;
  if (!types) {
    return ({ property: 'rental', hire: 'rental', rental: 'rental', services: 'service', education: 'service' })[categoryId] || 'product';
  }
  return types.indexOf('product') !== -1 ? 'product' : types.indexOf('rental') !== -1 ? 'rental' : 'service';
}

/** The 150 listings to make, spread evenly over the categories this store may use. */
function testDataPlan_(owner) {
  var cats = Object.keys(TEST_DATA_ITEMS).filter(function (c) { return c !== 'food' || canListFood(owner); });
  var plan = [];
  for (var i = 0; i < TEST_DATA_TOTAL; i++) {
    var cat = cats[i % cats.length];
    var round = Math.floor(i / cats.length);
    var names = TEST_DATA_ITEMS[cat];
    var base = names[round % names.length];
    plan.push({ key: i + 1, category: cat, name: TEST_DATA_PREFIX + base + (round >= names.length ? ' ' + (round + 1) : '') + ' (' + (i + 1) + ')' });
  }
  return plan;
}

function addTestProducts() {
  var started = Date.now();
  var owner = testDataStore_();
  var have = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (isTestProduct_(p, owner)) have[String(p.Name)] = true;
  });
  var plan = testDataPlan_(owner).filter(function (it) { return !have[it.name]; });
  var added = 0, refused = [];
  var run = String(started);   // a new request id each run, so a re-add after removal is not a replay
  for (var i = 0; i < plan.length; i++) {
    if ((Date.now() - started) / 1000 > TEST_DATA_SECONDS) break;
    var it = plan[i];
    var type = testDataType_(it.category);
    var price = Math.round((2 + Math.random() * (type === 'product' ? 60 : 120)) * 2) / 2;
    var res = actionCreateOrUpdateProduct(owner, {
      name: it.name,
      description: 'Test listing for trying out Mwakete - not a real item. ' + TEST_DATA_TAG,
      category: it.category,
      listingType: type,
      variants: [{ label: type === 'product' ? 'Standard' : type === 'rental' ? 'Per day' : 'Per job', price: price,
        stockQty: type === 'product' ? 5 + Math.floor(Math.random() * 60) : '' }],
      status: 'active',
      acknowledgeWarnings: true,
      requestId: 'testdata-' + run + '-' + it.key
    });
    if (res && res.ok) added++;
    else refused.push(it.name + ': ' + (res && res.error));
  }
  var left = plan.length - added - refused.length;
  var msg = 'Added ' + added + ' test products to ' + owner.StoreName + '.' +
    (refused.length ? ' Refused ' + refused.length + ':\n  ' + refused.join('\n  ') : '') +
    (left > 0 ? '\nStopped before the time limit - run addTestProducts again to add the other ' + left + '.' : '\nDone: the store has its ' + TEST_DATA_TOTAL + ' test products.');
  Logger.log(msg);
  return msg;
}

function removeTestProducts() {
  var started = Date.now();
  var owner = testDataStore_();
  var ids = sheetToObjects(getSheet('Products')).filter(function (p) { return isTestProduct_(p, owner); }).map(function (p) { return p.ProductId; });
  var removed = 0, refused = [];
  for (var i = 0; i < ids.length; i++) {
    if ((Date.now() - started) / 1000 > TEST_DATA_SECONDS) break;
    var res = actionDeleteProduct(owner, { productId: ids[i] });
    if (res && res.ok) removed++; else refused.push(ids[i] + ': ' + (res && res.error));
  }
  var left = ids.length - removed - refused.length;
  var msg = 'Removed ' + removed + ' test products from ' + owner.StoreName + '.' +
    (refused.length ? ' Not removed ' + refused.length + ':\n  ' + refused.join('\n  ') : '') +
    (left > 0 ? '\nStopped before the time limit - run removeTestProducts again for the other ' + left + '.' : '');
  Logger.log(msg);
  return msg;
}
