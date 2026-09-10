// Smart search intent & discovery.
//
// Two halves. The dictionary is tested as pure functions (no browser needed).
// The page is tested live, and the assertions that matter most are the ones
// about what must NOT change: a search that already works must not touch the
// intent layer, and must not make an extra request.
const fs = require('fs');
const vm = require('vm');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const intentSrc = fs.readFileSync(REPO + 'assets/js/search-intent.js', 'utf8');
const helpersSrc = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const sandbox = {};
vm.createContext(sandbox);
// `const` at the top level of a vm script stays lexical - it never lands on
// the context object - so the dictionary has to be handed out explicitly.
vm.runInContext(intentSrc + `
;globalThis.__exports = {
  SEARCH_INTENTS: SEARCH_INTENTS,
  SEARCH_STOPWORDS: SEARCH_STOPWORDS,
  SEARCH_VAGUE_WORDS: SEARCH_VAGUE_WORDS,
  detectSearchIntent: detectSearchIntent,
  normalizeSearchQuery: normalizeSearchQuery
};`, sandbox);
const X = sandbox.__exports;
const detect = X.detectSearchIntent;
const normalize = X.normalizeSearchQuery;

/* ---------- every suggested category must really exist ---------- */
const realIds = [...(helpersSrc.match(/const CATEGORIES = \[([\s\S]*?)\n\];/)[1]
  .matchAll(/id: '([a-z]+)'/g))].map((m) => m[1]);
const intentIds = Object.keys(X.SEARCH_INTENTS);
const invented = intentIds
  .map((id) => X.SEARCH_INTENTS[id].category)
  .filter((c) => realIds.indexOf(c) === -1);
ok('every intent points at a category that exists', invented.length === 0, invented.join(','));

const badTypes = intentIds
  .map((id) => X.SEARCH_INTENTS[id].listingType)
  .filter((t) => t && ['product', 'rental', 'service'].indexOf(t) === -1);
ok('every listing type on an intent is a real one', badTypes.length === 0, badTypes.join(','));

// A keyword that can never fire is a lie in the dictionary.
const vague = X.SEARCH_VAGUE_WORDS;
const dead = [];
intentIds.forEach((id) => {
  const it = X.SEARCH_INTENTS[id];
  // Single words only. Phrases are exempt by design - they are matched against
  // the raw query before stripping, and the particles holding them together
  // (ni, n, aika) are stopwords precisely so they can be.
  [].concat(it.strong, it.weak, it.local || []).forEach((w) => {
    if (vague.has(w) || X.SEARCH_STOPWORDS.has(w)) dead.push(id + ':' + w);
  });
});
ok('no keyword is also a stopword or a vague word', dead.length === 0, dead.join(', '));

/* ---------- normalization (spec section 5) ---------- */
ok('"I WANT FOOD!!!" normalizes to "i want food"', normalize('I WANT FOOD!!!') === 'i want food',
  normalize('I WANT FOOD!!!'));
ok('leading and repeated spaces collapse', normalize('   I   want  food  ') === 'i want food',
  normalize('   I   want  food  '));
ok('punctuation splits rather than fuses', normalize('food,drinks') === 'food drinks',
  normalize('food,drinks'));

/* ---------- the spec's own test cases (section 22) ---------- */
const cats = (q) => detect(q).matches.map((m) => m.category).join(',');
const conf = (q) => detect(q).confidence;

// Natural language
const NL = [
  ['I want food', 'food'],
  ['I need food', 'food'],
  ['I want something to eat', 'food'],
  ['Where can I get food?', 'food'],
  ['I need a phone', 'electronics'],
  ['I need something for my house', 'home,property'],
  ['I need transport', 'vehicles'],
  ['looking for a place to stay', 'property'],
  ['food for dinner', 'food'],
  ['I want a birthday cake', 'events,food']
];
NL.forEach(([q, expected]) => ok(`"${q}" -> ${expected}`, cats(q) === expected, cats(q)));

// Messy
['FOOD!!!', 'food please', '  I want food', 'Food for dinner'].forEach((q) => {
  ok(`messy: "${q}" still reads as food`, detect(q).matches[0] && detect(q).matches[0].category === 'food',
    cats(q));
});

// Exact single words keep working through the same dictionary
[['phone', 'electronics'], ['cake', 'food'], ['shirt', 'fashion'], ['car', 'vehicles']].forEach(([q, c]) => {
  ok(`exact word "${q}" -> ${c}`, cats(q) === c, cats(q));
});

// Unknown and vague - must NOT guess (spec section 6)
ok('"xyzabc123" identifies nothing', detect('xyzabc123').matches.length === 0 && conf('xyzabc123') === 'none');
ok('"something" asks what they want', conf('something') === 'empty' && detect('something').matches.length === 0);
ok('"help" asks what they want, it does not summon a plumber',
  conf('help') === 'empty' && detect('help').matches.length === 0, cats('help'));
ok('"I need it" identifies nothing', conf('I need it') === 'empty');
ok('an empty query identifies nothing', conf('') === 'empty');

/* ---------- confidence (spec section 6) ---------- */
ok('a clear phrase is high confidence', conf('I want food') === 'high');
ok('a vague phrase is hedged to medium', conf('something for dinner') === 'medium', conf('something for dinner'));
ok('"something for my home" is hedged too', conf('something for my home') === 'medium');
ok('an unplaced word hedges the answer', conf('phone for grandma') === 'medium', conf('phone for grandma'));

/* ---------- do not overmatch (spec section 6) ---------- */
ok('a weak-only runner-up behind a strong leader is dropped',
  cats('I need a phone for work') === 'electronics', cats('I need a phone for work'));
ok('but two strong hits are both offered',
  cats('I need a birthday gift') === 'events,handicrafts', cats('I need a birthday gift'));
ok('a genuinely ambiguous word offers both, hedged',
  cats('fish') === 'food,fishing' && conf('fish') === 'medium', `${cats('fish')} / ${conf('fish')}`);
ok('at most three suggestions ever reach the screen',
  detect('food phone car house gift fishing').matches.length <= 3);

/* ---------- price mood, not a category (spec section 12) ---------- */
ok('"cheap phone" is Electronics plus a price intent',
  cats('cheap phone') === 'electronics' && detect('cheap phone').cheap === true);
ok('"phone" alone carries no price intent', detect('phone').cheap === false);

/* ---------- a rental intent carries its listing type ---------- */
const stay = detect('somewhere to stay').matches[0];
ok('"somewhere to stay" is Property AND a rental',
  stay && stay.category === 'property' && stay.listingType === 'rental',
  JSON.stringify(stay));

/* ---------- the file is standalone ---------- */
ok('the dictionary makes no network call', !/fetch\(|XMLHttpRequest|Api\./.test(intentSrc));
ok('the dictionary touches no DOM', !/document\.|window\./.test(intentSrc));
ok('no library is loaded for this', !/require\(|import /.test(intentSrc));
/* ---------- te taetae ni Kiribati ---------- */
// The lists were supplied by a Kiribati speaker as "what shoppers actually
// type". They stayed empty until then, and this guard changed with them: it
// used to assert they were empty, which is exactly what it should have done
// while nothing trustworthy was in them.
ok('every category carries local words or phrases',
  intentIds.every((id) => {
    const it = X.SEARCH_INTENTS[id];
    return (it.local && it.local.length) || (it.phrases && it.phrases.length);
  }),
  intentIds.filter((id) => {
    const it = X.SEARCH_INTENTS[id];
    return !(it.local || []).length && !(it.phrases || []).length;
  }).join(','));

// Every supplied word must actually reach its category. A word sitting in the
// dictionary that the matcher never returns is worse than a missing one - it
// reads as covered.
const LOCAL = [
  ['te amwarake', 'food'], ['amwarake', 'food'],
  ['akawa', 'fishing'], ['kunikai', 'fashion'],
  ['bao ni mwamwananga', 'vehicles'],
  ['tareboon', 'electronics'], ['rerio', 'electronics'],
  ['aitibwaoki', 'electronics'], ['bwai n tiati', 'electronics'],
  ['timanti', 'building'], ['neera', 'building'], ['bwai ni mwakuri', 'building'],
  ['onaroka', 'agriculture'], ['aroka', 'agriculture'], ['takataka', 'agriculture'],
  ['karewe', 'agriculture'], ['beeki', 'agriculture'],
  ['kie', 'handicrafts'], ['raranga', 'handicrafts'], ['koikoi', 'handicrafts'],
  ['koro banna', 'handicrafts'], ['bwai n tangira', 'handicrafts'],
  ['tabo ni maeka', 'property'], ['ruu aika rent', 'property'], ['aba', 'property'],
  ['buramwa', 'services'], ['tia itutu', 'services'], ['tia koroira', 'services'],
  ['auti', 'home'], ['te reirei', 'education'], ['boki', 'education'], ['nakoa', 'education'],
  ['kai ni koboki', 'education'],
  ['botaki', 'events'], ['mare', 'events'], ['kiba', 'events'], ['tiketi', 'events']
];
LOCAL.forEach(([q, want]) => {
  const got = detect(q).matches.map((m) => m.category);
  ok(`local: "${q}" reaches ${want}`, got.indexOf(want) !== -1, got.join(',') || 'nothing');
});

// The article and the linking particles must not change the answer.
ok('"te" does not change what a search means',
  cats('te amwarake') === cats('amwarake'), `${cats('te amwarake')} vs ${cats('amwarake')}`);
ok('and it works mid-sentence too', cats('I want te amwarake') === 'food',
  cats('I want te amwarake'));

// bwai alone is "thing" - as vague as "something", and treated the same.
ok('"bwai" alone asks what they are looking for',
  conf('bwai') === 'empty' && detect('bwai').matches.length === 0, cats('bwai'));
// ...but it must not drag down the phrases it opens. A matched phrase is an
// exact request, not a vague one.
['bwai n tiati', 'bwai ni mwakuri', 'bwai n tangira'].forEach((q) => {
  ok(`"${q}" is confident despite starting with "bwai"`, conf(q) === 'high', conf(q));
});

/* ---------- the collisions, which are the interesting part ---------- */
// been = paint (Building) and pen (Education). Both offered, hedged - which is
// the honest answer, since the word genuinely means both.
ok('"been" offers Building and Education, hedged',
  cats('been') === 'building,education' && conf('been') === 'medium',
  `${cats('been')} / ${conf('been')}`);
// It had to be removed from the English stopwords to work at all. Check the
// English phrasing it collides with is still unharmed.
ok('removing "been" as a stopword did not spoil English phrasing',
  cats('I have been looking for a phone') === 'electronics',
  cats('I have been looking for a phone'));

// A phrase must beat the bare word inside it, or the particles decide nothing.
ok('"bwai ni mwakuri" (tools) beats the bare "mwakuri" (work)',
  cats('bwai ni mwakuri') === 'building' && cats('mwakuri') === 'education',
  `${cats('bwai ni mwakuri')} / ${cats('mwakuri')}`);
ok('"kai ni koboki" (pencil) beats the bare "kai" (timber)',
  cats('kai ni koboki') === 'education' && cats('kai') === 'building',
  `${cats('kai ni koboki')} / ${cats('kai')}`);

// 'auti' was given as Home's word ("house is auti"), so Home wins it outright
// rather than being hedged the way English "house" is. It stays weak under
// Property so it still counts in company: "auti aika rent" is a rental.
ok('"auti" alone is Home', cats('auti') === 'home' && conf('auti') === 'high',
  `${cats('auti')} / ${conf('auti')}`);
ok('"auti aika rent" puts Property first',
  detect('auti aika rent').matches[0].category === 'property',
  cats('auti aika rent'));
// English "house" keeps its own older behaviour, hedged across both - a
// separate decision, and not one this change should quietly alter.
ok('English "house" is still offered both ways',
  cats('house') === 'home,property', cats('house'));

/* ---------- live ---------- */
const mk = (cat, i) => ({
  productId: `${cat}-${i}`, name: `${cat} item ${i}`, category: cat, description: 'x',
  imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: `v${cat}${i}`, label: '1kg', price: 5 + i }],
  rating: null, reviewCount: 0, views: i, createdAt: '2026-01-01'
});

async function open(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; let q = null; let cat = null;
    try {
      const u = new URL(r.request().url());
      a = u.searchParams.get('action') || '';
      q = u.searchParams.get('q'); cat = u.searchParams.get('category');
    } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'searchProducts') {
      calls.push({ q: q || '', category: cat || '' });
      // The backend's real rule: one whole-phrase substring over name+description.
      // "i want food" therefore matches nothing, which is the bug being fixed.
      if (q) {
        const hits = q.toLowerCase() === 'phone' ? 3 : 0;
        return J({ ok: true, products: Array.from({ length: hits }, (_, i) => mk('electronics', i)) });
      }
      return J({ ok: true, products: Array.from({ length: 5 }, (_, i) => mk(cat || 'food', i)) });
    }
    return J({ ok: true, products: [], stores: [], tips: [] });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  return { ctx, page, errs, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // A search that WORKS must be untouched, and must not cost an extra request.
  {
    const { ctx, page, errs, calls } = await open(browser, '/search.html?q=phone');
    const cards = await page.locator('#results-list a[href*="product.html"]').count();
    ok('live: an exact search still returns its results', cards === 3, String(cards));
    ok('live: discovery stays hidden when there are results',
      await page.locator('#search-discovery').isHidden(), 'visible');
    ok('live: a working search makes exactly ONE backend request',
      calls.length === 1, JSON.stringify(calls));
    ok('live: no page errors on a working search', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // The whole point.
  {
    const { ctx, page, errs, calls } = await open(browser, '/search.html?q=I%20want%20food');
    const disc = page.locator('#search-discovery');
    ok('live: "I want food" shows discovery instead of a dead end',
      await disc.isVisible(), 'hidden');
    const lead = await disc.locator('.search-discovery-lead').innerText();
    ok('live: it names the category confidently', /Food & Groceries/.test(lead), lead);
    const chip = disc.locator('.chip-strip-item');
    ok('live: it offers at least one category chip', await chip.count() >= 1, String(await chip.count()));
    const href = await chip.first().getAttribute('href');
    ok('live: the chip links to a real category search', /category=food/.test(href), href);
    const cards = await page.locator('#results-list a[href*="product.html"]').count();
    ok('live: and fills the empty grid with that category', cards === 5, String(cards));
    ok('live: it cost exactly ONE extra request, not one per keystroke',
      calls.length === 2 && calls[1].category === 'food' && calls[1].q === '',
      JSON.stringify(calls));
    ok('live: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // Nothing readable - must not guess, must still help.
  {
    const { ctx, page, errs, calls } = await open(browser, '/search.html?q=xyzabc123');
    const disc = page.locator('#search-discovery');
    ok('live: an unknown search still gets a way forward', await disc.isVisible(), 'hidden');
    const lead = await disc.locator('.search-discovery-lead').innerText();
    ok('live: and is not given a guessed category',
      /Try a product name/.test(lead), lead);
    ok('live: popular categories are offered instead',
      await disc.locator('.chip-strip-item').count() >= 3,
      String(await disc.locator('.chip-strip-item').count()));
    ok('live: an unreadable search makes NO extra request', calls.length === 1, JSON.stringify(calls));
    ok('live: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // "something" - a shopper who has not said what they want.
  {
    const { ctx, page } = await open(browser, '/search.html?q=something');
    const lead = await page.locator('#search-discovery .search-discovery-lead').innerText();
    ok('live: "something" asks what they are looking for',
      /What are you looking for/.test(lead), lead);
    await ctx.close();
  }

  // Hedged wording for a vague phrase.
  {
    const { ctx, page } = await open(browser, '/search.html?q=something%20for%20my%20house');
    const lead = await page.locator('#search-discovery .search-discovery-lead').innerText();
    ok('live: a vague phrase is offered, not announced',
      /You may be looking for/.test(lead), lead);
    await ctx.close();
  }

  // Mobile: the discovery block must not overflow the screen.
  {
    const { ctx, page } = await open(browser, '/search.html?q=I%20want%20food');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('live: no horizontal overflow at 390px', !overflow, 'page scrolls sideways');
    const tall = await page.evaluate(() => {
      const c = document.querySelector('#search-discovery .chip-strip-item');
      return c ? c.getBoundingClientRect().height : 0;
    });
    ok('live: chips are a touch-friendly height', tall >= 32, String(tall));
    await ctx.close();
  }

  await browser.close();

  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  ok('the new file is precached, so it works offline', /assets\/js\/search-intent\.js/.test(sw));
  const html = fs.readFileSync(REPO + 'search.html', 'utf8');
  ok('and is loaded before search.js, which calls it',
    html.indexOf('search-intent.js') < html.indexOf('js/search.js'));

  // No .gs file should have been touched at all.
  const { execSync } = require('child_process');
  let gs = '';
  try { gs = execSync('git -C ' + REPO + ' diff --name-only origin/main -- apps-script/', { encoding: 'utf8' }).trim(); } catch (e) {}
  ok('the backend was not changed', gs === '', gs);

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
