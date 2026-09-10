/* ===========================================================================
   Smart search intent - V1, local rules only.

   WHY THIS EXISTS
   actionSearchProducts (Products.gs) matches ONE substring:

       haystack = (Name + ' ' + Description).toLowerCase()
       if (haystack.indexOf(q) === -1) drop

   So "I want food" is looked up as the literal string "i want food" and can
   never match "Fried rice". The shopper gets a dead end for a request the
   marketplace can obviously serve. This file turns that sentence into a
   category the marketplace actually has.

   WHAT IT IS NOT
   No AI, no API, no library, no network. Pure functions over a dictionary:
   text in, category ids out. It runs only when a search returned nothing, so
   a search that already works never touches it (see search.js, renderNoResults).

   THE ONE HARD RULE
   Every intent points at a category id that EXISTS in CATEGORIES (helpers.js).
   Suggesting "Cakes & Desserts" to a shopper would be inventing a shelf the
   marketplace does not have, and the chip would lead nowhere. A test asserts
   every id here resolves.

   ADDING TO IT
   Add keywords, not code. Each intent has `strong` (this word alone is enough)
   and `weak` (a hint, and usually a word that honestly belongs to two
   categories - "fish" is dinner or it is tackle). Both lists are matched as
   whole words after normalization.

   NOT YET, AND DELIBERATELY: te taetae ni Kiribati. Every intent carries an
   empty `local` list for Gilbertese terms - te amwarake, te kai ni ika and so
   on. It is empty because guessing at a language I cannot check would put
   wrong words in front of shoppers, and a wrong keyword is worse than a
   missing one. Someone who speaks it should fill these in; nothing else needs
   to change when they do.
   =========================================================================== */

/**
 * Words that carry no shopping meaning. Stripped before matching, so
 * "where can I buy food" and "food" reach the dictionary as the same thing.
 *
 * Verbs of wanting live here on purpose - want, need, looking, buy - because
 * every one of them appears in the phrasings this feature exists to handle.
 */
const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'is', 'are', 'am', 'was', 'were',
  'be', 'been', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will',
  'shall', 'may', 'might', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'from',
  'with', 'about', 'into', 'up', 'out', 'over', 'under', 'i', 'me', 'my', 'mine',
  'we', 'us', 'our', 'you', 'your', 'yours', 'he', 'she', 'it', 'its', 'they',
  'them', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'where',
  'what', 'which', 'who', 'whom', 'how', 'when', 'why', 'want', 'wants',
  'wanted', 'wanting', 'need', 'needs', 'needed', 'needing', 'look', 'looks',
  'looking', 'buy', 'buys', 'buying', 'bought', 'get', 'gets', 'getting',
  'find', 'finds', 'finding', 'sell', 'sells', 'selling', 'have', 'has', 'had',
  'please', 'pls', 'any', 'some', 'all', 'more', 'most', 'very', 'really',
  'just', 'now', 'today', 'tonight', 'tomorrow', 'near', 'nearby', 'around',
  'good', 'best', 'nice', 'new', 'old', 'go', 'going'
]);

/**
 * Words that say "I am not sure what I want". They never match an intent
 * themselves; their job is to HEDGE one. "something for dinner" is a food
 * search, but it is a browsing mood, not an order - so the copy says "you may
 * be looking for" instead of announcing the answer.
 *
 * They are also stopwords, so a query made only of these leaves nothing behind
 * and lands on "What are you looking for?" rather than a guess.
 */
const SEARCH_VAGUE_WORDS = new Set([
  'something', 'anything', 'somewhere', 'anywhere', 'someone', 'anyone',
  'thing', 'things', 'stuff', 'help', 'idea', 'ideas', 'options', 'option'
]);

/** A price mood, not a category. Turns into sort=cheapest on the chips. */
const SEARCH_CHEAP_WORDS = new Set([
  'cheap', 'cheapest', 'cheaper', 'affordable', 'budget', 'bargain', 'discount'
]);

/**
 * intent id -> where it points and what triggers it.
 *
 *   category    a real CATEGORIES id (helpers.js). Asserted by a test.
 *   listingType optional - some intents are about HOW you get a thing, not
 *               what it is. "somewhere to stay" is Property AND a rental;
 *               without the type the shopper lands on land for sale.
 *   strong      2 points. This word alone identifies the intent.
 *   weak        1 point. A hint - usually a word that honestly belongs to two
 *               categories, and is listed under both so the shopper is offered
 *               both rather than being guessed at.
 *   local       Gilbertese terms. Empty by design - see the header.
 */
const SEARCH_INTENTS = {
  food: {
    category: 'food',
    strong: ['food', 'eat', 'eating', 'meal', 'lunch', 'dinner', 'breakfast',
      'supper', 'hungry', 'takeaway', 'takeaways', 'snack', 'grocery',
      'groceries', 'restaurant', 'cafe', 'cook', 'cooking', 'catering',
      'bread', 'rice', 'cake', 'cakes', 'sugar', 'flour', 'noodle', 'noodles',
      'drink', 'drinks', 'beverage', 'juice', 'water', 'tea', 'coffee',
      'sweets', 'lolly', 'lollies', 'biscuit', 'biscuits'],
    // Both of these are dinner or they are livestock/tackle. Offered, not assumed.
    weak: ['fish', 'chicken', 'pork', 'egg', 'eggs', 'coconut'],
    local: []
  },
  fashion: {
    category: 'fashion',
    strong: ['clothes', 'clothing', 'shirt', 'shirts', 'tshirt', 'dress',
      'dresses', 'skirt', 'trousers', 'shorts', 'shoe', 'shoes', 'sandal',
      'sandals', 'slippers', 'hat', 'uniform', 'salon', 'beauty', 'makeup',
      'cosmetics', 'perfume', 'jewellery', 'jewelry', 'earring', 'earrings',
      'necklace', 'bracelet', 'watch', 'handbag', 'wear', 'haircut'],
    weak: ['bag', 'hair', 'ring'],
    local: []
  },
  electronics: {
    category: 'electronics',
    strong: ['phone', 'phones', 'mobile', 'smartphone', 'laptop', 'computer',
      'pc', 'tablet', 'ipad', 'tv', 'television', 'radio', 'speaker',
      'speakers', 'charger', 'battery', 'headphone', 'headphones', 'earphones',
      'camera', 'printer', 'usb', 'sim', 'internet', 'wifi', 'fridge',
      'freezer', 'microwave', 'electronics', 'electronic'],
    weak: ['screen', 'cable', 'power'],
    local: []
  },
  home: {
    category: 'home',
    strong: ['furniture', 'bed', 'beds', 'mattress', 'chair', 'chairs',
      'table', 'tables', 'sofa', 'cupboard', 'shelf', 'kitchen', 'curtain',
      'curtains', 'pillow', 'blanket', 'bedsheet', 'towel', 'fan', 'lamp',
      'bucket', 'broom', 'detergent', 'soap', 'household', 'furnishing'],
    // "house" is a room to rent as often as it is something to put in one.
    weak: ['house', 'home', 'mat', 'cleaning', 'laundry'],
    local: []
  },
  building: {
    category: 'building',
    strong: ['cement', 'timber', 'plywood', 'nails', 'roofing', 'roof',
      'paint', 'hardware', 'hammer', 'saw', 'drill', 'pipe', 'plumbing',
      'construction', 'build', 'building', 'builder', 'brick', 'sand',
      'gravel', 'tile', 'tiles', 'welding'],
    weak: ['tools', 'wood', 'iron', 'wire'],
    local: []
  },
  vehicles: {
    category: 'vehicles',
    strong: ['car', 'cars', 'vehicle', 'vehicles', 'truck', 'motorbike',
      'motorcycle', 'bike', 'bicycle', 'scooter', 'transport', 'transportation',
      'taxi', 'bus', 'tyre', 'tyres', 'tire', 'petrol', 'diesel', 'fuel',
      'driving', 'mechanic', 'spare', 'ute', 'van'],
    weak: ['engine', 'oil', 'ride'],
    local: []
  },
  fishing: {
    category: 'fishing',
    strong: ['fishing', 'net', 'nets', 'hook', 'hooks', 'bait', 'canoe',
      'outboard', 'dive', 'diving', 'snorkel', 'spear', 'marine', 'boat',
      'boats', 'anchor', 'reef', 'tackle'],
    weak: ['fish', 'sea', 'line', 'engine'],
    local: []
  },
  agriculture: {
    category: 'agriculture',
    strong: ['farm', 'farming', 'plant', 'plants', 'seed', 'seeds', 'garden',
      'gardening', 'crop', 'crops', 'copra', 'toddy', 'babai', 'pig', 'pigs',
      'livestock', 'fertilizer', 'fertiliser', 'compost', 'harvest'],
    weak: ['coconut', 'chicken', 'local', 'tree'],
    local: []
  },
  handicrafts: {
    category: 'handicrafts',
    strong: ['handicraft', 'handicrafts', 'souvenir', 'souvenirs', 'craft',
      'crafts', 'weaving', 'woven', 'carving', 'carved', 'pandanus', 'shell',
      'shells', 'gift', 'gifts', 'present', 'presents', 'handmade'],
    weak: ['mat', 'necklace', 'model'],
    local: []
  },
  property: {
    category: 'property',
    // Not just Property: without the rental type a shopper asking for a room
    // for the night is shown land for sale.
    listingType: 'rental',
    strong: ['rent', 'rental', 'renting', 'accommodation', 'apartment', 'flat',
      'room', 'rooms', 'lodge', 'lodging', 'motel', 'hotel', 'guesthouse',
      'stay', 'staying', 'lease', 'tenant', 'land', 'property'],
    weak: ['house', 'place', 'night'],
    local: []
  },
  services: {
    category: 'services',
    listingType: 'service',
    strong: ['service', 'services', 'repair', 'repairs', 'fix', 'fixing',
      'install', 'installation', 'plumber', 'electrician', 'carpenter',
      'tailor', 'barber', 'printing', 'photocopy', 'delivery', 'labour',
      'maintenance'],
    // 'help' is deliberately NOT here: it is a vague word, consumed before
    // matching, because a shopper typing "help" wants guidance and not a
    // plumber. Listing it would be a dictionary entry that never fires.
    weak: ['cleaning', 'mechanic', 'work'],
    local: []
  },
  education: {
    category: 'education',
    strong: ['school', 'teacher', 'tuition', 'tutor', 'tutoring', 'lesson',
      'lessons', 'course', 'courses', 'training', 'study', 'studying', 'exam',
      'job', 'jobs', 'employment', 'hiring', 'vacancy', 'cv', 'resume',
      'stationery', 'notebook', 'pen', 'pens', 'pencil'],
    weak: ['book', 'books', 'learn', 'work'],
    local: []
  },
  events: {
    category: 'events',
    strong: ['event', 'events', 'party', 'parties', 'birthday', 'wedding',
      'anniversary', 'celebration', 'funeral', 'travel', 'flight', 'flights',
      'ticket', 'tickets', 'tour', 'holiday', 'decoration', 'decorations',
      'balloon', 'balloons', 'photography', 'photographer', 'band', 'dj'],
    weak: ['gift', 'cake', 'catering', 'music'],
    local: []
  }
};

/**
 * Lowercase, strip punctuation, collapse whitespace.
 * "I WANT FOOD!!!" -> "i want food"
 */
function normalizeSearchQuery(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    // Keep letters, digits and spaces; everything else becomes a space so
    // "food,drinks" splits into two words rather than fusing into one.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Crude, deliberate singularization. Not a stemmer - a stemmer would turn
 * "shoes" into "shoe" and "business" into "busi", and the second kind of
 * mistake is the one that produces a wrong suggestion.
 *
 * Returns the word unchanged whenever it is not confident.
 */
function singularizeSearchWord(word) {
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word;      // glass, status, analysis
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ch|sh|x|z|s)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The meaningful words in a query, with the moods it carried.
 *
 * `terms` keeps both the word as typed and its singular, because the
 * dictionary holds some words in both forms and matching either is cheaper
 * than being clever.
 */
function searchQueryTerms(raw) {
  const words = normalizeSearchQuery(raw).split(' ').filter(Boolean);
  const terms = [];
  let vague = false;
  let cheap = false;

  words.forEach((w) => {
    if (SEARCH_VAGUE_WORDS.has(w)) { vague = true; return; }
    if (SEARCH_CHEAP_WORDS.has(w)) { cheap = true; return; }
    if (SEARCH_STOPWORDS.has(w)) return;
    const single = singularizeSearchWord(w);
    terms.push(single);
    if (single !== w) terms.push(w);
  });

  return { terms, vague, cheap, wordCount: words.length };
}

/**
 * Read a shopping intent out of a search phrase.
 *
 * Returns:
 *   confidence  'high'   - act on it, say so plainly
 *               'medium' - offer it, hedged: "you may be looking for"
 *               'none'   - meaningful words, but none we recognise
 *               'empty'  - nothing meaningful at all ("something", "help")
 *   matches     [{ intentId, category, listingType, score }], best first
 *   cheap       the shopper asked for cheap - callers sort by price
 *
 * The confidence rule, stated once so it can be argued with:
 *   score 2 comes from a `strong` word, 1 from a `weak` one.
 *   HIGH needs a strong hit AND no vagueness marker AND every meaningful word
 *   accounted for. Anything the shopper said that we could not place is a
 *   reason to hedge, not to ignore - "phone for work" is probably Electronics,
 *   but "work" might have been the point.
 */
function detectSearchIntent(raw) {
  const { terms, vague, cheap } = searchQueryTerms(raw);
  const empty = { confidence: 'empty', matches: [], terms: [], cheap: cheap };
  if (!terms.length) return empty;

  const scores = {};
  const placed = new Set();

  Object.keys(SEARCH_INTENTS).forEach((id) => {
    const intent = SEARCH_INTENTS[id];
    let score = 0;
    terms.forEach((t) => {
      if (intent.strong.indexOf(t) !== -1) { score += 2; placed.add(t); }
      else if (intent.weak.indexOf(t) !== -1) { score += 1; placed.add(t); }
      else if (intent.local.indexOf(t) !== -1) { score += 2; placed.add(t); }
    });
    if (score > 0) scores[id] = score;
  });

  const ids = Object.keys(scores);
  if (!ids.length) return { confidence: 'none', matches: [], terms: terms, cheap: cheap };

  ids.sort((a, b) => scores[b] - scores[a]);
  const top = scores[ids[0]];

  // Runners-up are offered too - "birthday gift" wants Events AND Handicrafts,
  // not an argument about which one won. But a WEAK-only runner-up behind a
  // strong leader is noise: "a phone for work" scored Electronics 2 and then
  // Services and Education 1 apiece off the single word "work", and three
  // chips for one obvious answer is the overmatching this feature is supposed
  // to avoid. So a runner-up must be strong in its own right, unless nothing
  // strong matched at all - in which case the weak hits are all there is, and
  // "something for my house" rightly offers both Home and Property.
  const floor = top >= 2 ? 2 : 1;
  const matches = ids
    .filter((id) => scores[id] >= top - 1 && scores[id] >= floor)
    .slice(0, 3)
    .map((id) => ({
      intentId: id,
      category: SEARCH_INTENTS[id].category,
      listingType: SEARCH_INTENTS[id].listingType || '',
      score: scores[id]
    }));

  // Distinct meaningful words, since searchQueryTerms may add a plural twin.
  const meaningful = terms.filter((t, i) => terms.indexOf(t) === i);
  const allPlaced = meaningful.every((t) => placed.has(t) || placed.has(singularizeSearchWord(t)));

  const confidence = (top >= 2 && !vague && allPlaced) ? 'high' : 'medium';
  return { confidence: confidence, matches: matches, terms: terms, cheap: cheap };
}
