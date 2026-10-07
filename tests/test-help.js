/**
 * Help Centre content + search, in Node.
 *
 *  - help.html is in step with help-content.js (build --check)
 *  - every entry is well-formed, every related link resolves
 *  - no content promises something Mwakete does not do
 *  - the search ranks the way the brief asks, and survives bad input
 *  - the page's fixed strings match HELP_STRINGS (translation source)
 *  - structured data comes from the same FAQs, with nothing extra
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const C = require(REPO + '/assets/js/help-content.js');
const { HelpSearch } = require(REPO + '/assets/js/help-search.js');
const { mwaketeIcon, MWAKETE_ICON_PATHS } = require(REPO + '/assets/js/help-icons.js');
const html = fs.readFileSync(REPO + '/help.html', 'utf8');

/* ---------- build is current ---------- */
let buildOk = true;
try { execSync('node tools/build-help.js --check', { cwd: REPO, stdio: 'pipe' }); } catch (e) { buildOk = false; }
ok('help.html matches help-content.js (node tools/build-help.js --check)', buildOk);

/* ---------- content shape ---------- */
const cats = new Set(C.HELP_CATEGORIES.map((c) => c.id));
const all = C.HELP_FAQS.concat(C.HELP_GUIDES);
const ids = all.map((e) => e.id);
ok('ids are unique', new Set(ids).size === ids.length);
ok('every entry has title, subtitle, description and a known category',
  all.every((e) => e.title && e.subtitle && e.description && cats.has(e.category)),
  all.filter((e) => !(e.title && e.subtitle && e.description && cats.has(e.category))).map((e) => e.id).join(','));
ok('every FAQ has keywords', C.HELP_FAQS.every((f) => Array.isArray(f.keywords) && f.keywords.length >= 3));
ok('every related id resolves', all.every((e) => (e.related || []).every((id) => ids.indexOf(id) !== -1)));
ok('every category has at least one FAQ', [...cats].every((c) => C.HELP_FAQS.some((f) => f.category === c)));
ok('guides shown here have steps; linked guides have a url',
  C.HELP_GUIDES.every((g) => g.url ? fs.existsSync(path.join(REPO, g.url.split('?')[0])) : g.steps && g.steps.length >= 3));
ok('popular FAQs exist', C.HELP_POPULAR_FAQS.every((id) => ids.indexOf(id) !== -1));
ok('the brief\'s FAQ list is covered (45+ questions)', C.HELP_FAQS.length >= 45, C.HELP_FAQS.length);
ok('no blog posts are invented (Mwakete has no blog yet)', C.HELP_BLOG_POSTS.length === 0);

/* ---------- honesty ---------- */
const text = all.map((e) => [e.title, e.subtitle, e.description].concat(e.steps || []).join(' ')).join(' ').toLowerCase();
const banned = ['guarantee', 'refund guaranteed', 'we refund', 'money back', 'buyer protection', 'payment protection',
  'insured', 'we deliver', 'mwakete delivers', 'free delivery on all', 'always verified'];
ok('no promises Mwakete cannot keep', banned.every((b) => text.indexOf(b) === -1),
  banned.filter((b) => text.indexOf(b) !== -1).join(','));
ok('payments: says Mwakete never takes or holds money',
  /never takes payment/.test(C.HELP_FAQS.find((f) => f.id === 'buying-pay').description));
ok('content is plain text, never HTML', all.every((e) => !/[<>]/.test(JSON.stringify(e))));
ok('every link in content is internal or the support mailto',
  all.every((e) => !e.action || /^(mailto:admin@mwakete\.com|[a-z].*\.html)/.test(e.action.href)));

/* ---------- search ---------- */
const index = HelpSearch.build({ categories: C.HELP_CATEGORIES, faqs: C.HELP_FAQS, guides: C.HELP_GUIDES, blog: C.HELP_BLOG_POSTS });
const top = (q, o) => HelpSearch.search(index, q, o).map((r) => r.item.id);
ok('exact title ranks first', top('How do I sell on Mwakete?')[0] === 'selling-how');
ok('case and punctuation do not matter', top('HOW DO I SELL ON MWAKETE')[0] === 'selling-how');
ok('a loose question finds the selling answers and the guide',
  top('How can I sell products?').slice(0, 3).indexOf('selling-how') !== -1
  && top('How can I sell products?').slice(0, 4).indexOf('guide-first-listing') !== -1, top('How can I sell products?').slice(0, 4).join(','));
ok('a typo still finds it (shiping)', top('shiping').some((id) => /^delivery-/.test(id)));
ok('synonym: "ship" finds delivery answers', top('ship').some((id) => /^delivery-/.test(id)));
ok('"payments" puts How do I pay? first', top('payments')[0] === 'buying-pay', top('payments').slice(0, 3).join(','));
ok('"scam" puts the scam answer first', top('scam')[0] === 'safety-scam');
ok('"excel" finds the stock answer and guide', top('excel').indexOf('business-inventory') !== -1 && top('excel').indexOf('guide-connect-stock') !== -1);
ok('nonsense finds nothing', top('qwertyzz').length === 0);
ok('both types come back, labelled', new Set(HelpSearch.search(index, 'listing').map((r) => r.item.type)).size === 2);
ok('type filter: guides only', top('sell', { type: 'guide' }).every((id) => /^guide-/.test(id)) && top('sell', { type: 'guide' }).length > 0);
ok('topic filter: safety only', HelpSearch.search(index, 'pay', { topic: 'safety' }).every((r) => r.item.category === 'safety'));
ok('empty query returns everything (browse)', HelpSearch.search(index, '').length === index.length);
ok('hostile input is just text', HelpSearch.search(index, '<img src=x onerror=alert(1)>').length >= 0
  && HelpSearch.search(index, '((((([[[[*+?').length === index.length);   // no letters = no query
ok('a huge query does not hang', (() => { const t = Date.now(); HelpSearch.search(index, 'sell '.repeat(5000)); return Date.now() - t < 200; })());
ok('a malformed entry is skipped, not fatal',
  HelpSearch.build({ categories: [], faqs: [null, { id: 'x' }, { id: 'y', title: 'Ok' }], guides: [], blog: [] }).length === 1);
// A keystroke runs at most one search (debounced). 5ms here is ~50ms on a
// slow phone - far inside the 200ms INP budget.
ok('fast: a long question searches in under 5ms', (() => { const t = Date.now(); for (let i = 0; i < 200; i++) HelpSearch.search(index, 'how do i get delivery to the outer islands'); return (Date.now() - t) / 200 < 5; })());
ok('result urls are only help anchors or site pages',
  index.every((it) => /^(help\.html#[\w-]+|[a-z0-9][a-z0-9\-/]*\.html)$/.test(it.url)), index.map((i) => i.url).filter((u) => !/^(help\.html#|[a-z])/.test(u)).join(','));

/* ---------- icons ---------- */
ok('every category icon exists', C.HELP_CATEGORIES.every((c) => MWAKETE_ICON_PATHS[c.icon]));
ok('icons are decorative by default', /aria-hidden="true"/.test(mwaketeIcon('search')));
ok('an icon given a label is announced', /role="img" aria-label="Search"/.test(mwaketeIcon('search', { label: 'Search' })));
ok('a label cannot break out of the attribute', mwaketeIcon('search', { label: '"><script>' }).indexOf('<script>') === -1);
ok('one style: every icon is stroke-only, 24-unit box',
  Object.keys(MWAKETE_ICON_PATHS).every((k) => !/fill="(?!none)/.test(MWAKETE_ICON_PATHS[k])));

/* ---------- page: strings, SEO, structured data ---------- */
const T = C.HELP_STRINGS.en;
ok('page strings match HELP_STRINGS.en (the translation source)',
  [T.heroTitle, T.heroText, T.searchPlaceholder, T.stillButton, T.categoriesTitle, T.faqTitle, T.guidesTitle]
    .every((s) => html.indexOf(s) !== -1));
ok('title', /<title>Mwakete Help Centre \| FAQs, Guides &amp; Support<\/title>/.test(html));
ok('meta description', /name="description" content="Find answers, guides, safety information and useful tips for buying, selling and using Mwakete in Kiribati\."/.test(html));
ok('canonical', /<link rel="canonical" href="https:\/\/mwakete\.com\/help">/.test(html));
ok('Open Graph + Twitter', /og:title/.test(html) && /og:description/.test(html) && /twitter:card/.test(html));
const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const faqLd = ld.find((x) => x['@type'] === 'FAQPage');
ok('FAQPage JSON-LD has exactly the FAQs, in order', faqLd && faqLd.mainEntity.length === C.HELP_FAQS.length
  && faqLd.mainEntity.every((q, i) => q.name === C.HELP_FAQS[i].title));
ok('every JSON-LD answer is the visible answer text', faqLd.mainEntity.every((q, i) =>
  q.acceptedAnswer.text === C.HELP_FAQS[i].description.replace(/\n\s*\n/g, ' ')));
ok('breadcrumb JSON-LD', ld.some((x) => x['@type'] === 'BreadcrumbList'));
ok('every FAQ is in the page markup with a real button',
  C.HELP_FAQS.every((f) => html.indexOf('id="faq-' + f.id + '-btn"') !== -1));
ok('one h1', (html.match(/<h1[\s>]/g) || []).length === 1);

/* ---------- wiring ---------- */
const sw = fs.readFileSync(REPO + '/sw.js', 'utf8');
ok('help page and scripts are precached for offline use',
  ['help.html', 'help-content.min.js', 'help-icons.min.js', 'help-search.min.js', 'help.min.js'].every((f) => sw.indexOf(f) !== -1));
ok('header menu links Help & Support to the Help Centre',
  /label: 'Help & Support',\s*href: 'help.html'/.test(fs.readFileSync(REPO + '/assets/js/header-menu.js', 'utf8')));
ok('no secrets or API keys in the Help Centre files', !/(api[_-]?key|secret|token\s*[:=])/i.test(
  ['help-content.js', 'help-search.js', 'help-icons.js', 'help.js'].map((f) => fs.readFileSync(REPO + '/assets/js/' + f, 'utf8')).join('\n')));

let f = 0;
console.log('\n--- Help Centre: content + search ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
