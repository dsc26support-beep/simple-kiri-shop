/**
 * Help Centre search: ONE ranked search over FAQs, guides and blog posts.
 *
 * No search service, no index file, no library. The whole knowledge base is a
 * few dozen entries already on the page (help-content.js), so the fastest
 * thing is to search it in memory: a query is a few hundred string compares,
 * well under a millisecond on a cheap phone.
 *
 * HOW A QUERY IS MATCHED
 *   1. Lower-cased, accents folded, punctuation dropped.
 *   2. Filler words dropped ("how can I ..."), so "How can I sell products?"
 *      searches for sell + product.
 *   3. Each word is cut to a rough stem (selling -> sell, payments -> payment)
 *      and widened with a few synonyms (ship -> delivery, scam -> fraud).
 *   4. A word matches a field if a field word starts with it, it starts with a
 *      field word, or - for longer words - they are one typo apart.
 *
 * HOW RESULTS ARE RANKED (the brief's order)
 *   exact title > strong title > category > tags/keywords > subtitle >
 *   description > body. Each query word scores the best field it hits;
 *   an entry must match at least half the query's words to be shown.
 *
 * Pure functions, no DOM: tests/test-help.js runs it in Node.
 */
const HelpSearch = (function () {
  const STOP = new Set(('a an and are as at be by can could do does for from get got have how i if in into is it '
    + 'its me my mwakete of on or our please should so that the their them there this to us was we what when '
    + 'where which who why will with would you your about any some way ways want need help').split(' '));

  // Groups of words that should find each other. Keys and members are stems.
  const SYNONYM_GROUPS = [
    ['sell', 'seller', 'vendor', 'listing', 'list'],
    ['buy', 'purchase', 'order', 'shop'],
    ['pay', 'payment', 'money', 'cash', 'bank'],
    ['deliver', 'delivery', 'ship', 'shipping', 'send', 'courier', 'freight', 'transport'],
    ['pickup', 'pick', 'collect'],
    ['account', 'login', 'signin', 'sign', 'password', 'register'],
    ['scam', 'fraud', 'fake', 'suspicious', 'cheat'],
    ['rent', 'rental', 'hire', 'lease'],
    ['store', 'shop', 'business'],
    ['island', 'outer', 'kiritimati', 'tarawa'],
    ['cancel', 'cancellation', 'refund', 'return'],
    ['contact', 'message', 'chat', 'call', 'email', 'support'],
    ['safe', 'safety', 'secure', 'security', 'trust']
  ];

  function fold(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function stem(w) {
    if (w.length > 6 && /ments?$/.test(w)) return w.replace(/ments?$/, '');   // payment -> pay
    if (w.length > 5 && /ings?$/.test(w)) return w.replace(/ings?$/, '');
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ers|ed)$/.test(w)) return w.replace(/(ers|ed)$/, '');
    if (w.length > 4 && /es$/.test(w) && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function words(s) {
    return fold(s).split(' ').filter(Boolean).map(stem);
  }

  /** Unique words only: a field's repeats cannot change whether it matches. */
  function uniqueWords(s) {
    return Array.from(new Set(words(s)));
  }

  const SYNONYMS = {};
  SYNONYM_GROUPS.forEach((group) => {
    const stems = group.map(stem);
    stems.forEach((w) => { SYNONYMS[w] = (SYNONYMS[w] || []).concat(stems); });
  });

  /** One typo apart (insert, delete or substitute), for words of 5+ letters. */
  function nearlyEqual(a, b) {
    if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function wordMatches(q, fieldWords) {
    for (let k = 0; k < fieldWords.length; k++) {
      const f = fieldWords[k];
      if (f === q) return 2;
      if (f.indexOf(q) === 0 && q.length >= 2) return 1.5;
      if (q.indexOf(f) === 0 && f.length >= 4) return 1.2;
      if (nearlyEqual(q, f)) return 1;
    }
    return 0;
  }

  // Field weights, highest first, in the brief's ranking order.
  const FIELDS = [
    ['title', 12], ['category', 9], ['tags', 7], ['subtitle', 5], ['description', 3], ['body', 2]
  ];

  /**
   * Builds the normalized list the search runs on, from help-content.js.
   * Each entry keeps its display fields plus pre-split words per field, so a
   * keystroke does no re-splitting.
   */
  function build(content) {
    const cats = {};
    (content.categories || []).forEach((c) => { cats[c.id] = c; });
    const items = [];
    const push = (type, e, extra) => {
      if (!e || !e.id || !e.title) return;   // malformed entry: skip, never crash
      const cat = cats[e.category] || {};
      const item = Object.assign({
        type: type,
        id: String(e.id),
        title: String(e.title),
        subtitle: String(e.subtitle || ''),
        description: String(e.description || ''),
        category: String(e.category || ''),
        categoryTitle: String(cat.title || ''),
        tags: (e.keywords || e.tags || []).map(String),
        body: '',
        url: e.url || ''
      }, extra || {});
      item.w = {
        title: uniqueWords(item.title),
        category: uniqueWords(item.category + ' ' + item.categoryTitle),
        tags: uniqueWords(item.tags.join(' ')),
        subtitle: uniqueWords(item.subtitle),
        description: uniqueWords(item.description),
        body: uniqueWords(item.body)
      };
      item.foldedTitle = fold(item.title);
      items.push(item);
    };
    const ok = (e) => e && typeof e === 'object';
    (content.faqs || []).filter(ok).forEach((f) => push('faq', f, { url: 'help.html#faq-' + f.id }));
    (content.guides || []).filter(ok).forEach((g) => push('guide', g, {
      body: (g.steps || []).join(' '),
      url: g.url || ('help.html#' + g.id),
      minutes: g.minutes || null
    }));
    (content.blog || []).filter(ok).forEach((b) => push('blog', b, {
      publishedAt: b.publishedAt || '',
      minutes: b.minutes || null
    }));
    return items;
  }

  function queryWords(query) {
    const all = words(query);
    const meaningful = all.filter((w) => !STOP.has(w));
    return meaningful.length ? meaningful : all;
  }

  const TYPE_ORDER = { faq: 0, guide: 1, blog: 2 };
  const MIN_SHARE_OF_TOP = 0.35;
  const MAX_RESULTS = 20;

  /**
   * opts.type  'all' | 'faq' | 'guide' | 'blog'
   * opts.topic category id, or '' for every topic
   * Returns [{ item, score }], best first.
   */
  function search(items, query, opts) {
    opts = opts || {};
    const type = opts.type && opts.type !== 'all' ? opts.type : '';
    const topic = opts.topic || '';
    const pool = items.filter((it) => (!type || it.type === type) && (!topic || it.category === topic));
    const q = fold(query).slice(0, 200);
    if (!q) return pool.map((item) => ({ item: item, score: 0 }));

    const qWords = queryWords(q).slice(0, 12);
    const needed = Math.max(1, Math.ceil(qWords.length / 2));
    const results = [];

    pool.forEach((it) => {
      let score = 0;
      let hit = 0;
      let bonus = 0;
      if (it.foldedTitle === q) bonus = 100;                                      // exact title
      else if (q.length >= 4 && it.foldedTitle.indexOf(q) !== -1) bonus = 40;    // title contains the phrase

      qWords.forEach((w) => {
        const variants = [w].concat(SYNONYMS[w] || []);
        let best = 0;
        FIELDS.forEach(([field, weight]) => {
          variants.forEach((v, idx) => {
            const m = wordMatches(v, it.w[field]);
            if (!m) return;
            // A synonym counts, but less than the word the person typed.
            const s = weight * m * (idx === 0 ? 1 : 0.6);
            if (s > best) best = s;
          });
        });
        if (best > 0) { hit++; score += best; }
      });

      if (hit < needed) return;
      score += (hit / qWords.length) * 10;                           // covering more words wins
      results.push({ item: it, score: score + bonus, base: score });
    });

    results.sort((a, b) => b.score - a.score
      || TYPE_ORDER[a.item.type] - TYPE_ORDER[b.item.type]
      || a.item.title.length - b.item.title.length);
    // Keep the list focused: a result scoring a fraction of the best one is
    // usually a stray synonym or category hit, and a long tail of those buries
    // the answer on a phone screen.
    // Measured on the word-by-word score, not the exact-title bonus, so one
    // perfect title match does not hide every related answer.
    const top = results.reduce((m, r) => Math.max(m, r.base), 0);
    return results.filter((r) => r.base >= top * MIN_SHARE_OF_TOP).slice(0, MAX_RESULTS)
      .map((r) => ({ item: r.item, score: r.score }));
  }

  return { build: build, search: search, fold: fold, stem: stem, words: words };
})();

if (typeof module !== 'undefined') module.exports = { HelpSearch };
