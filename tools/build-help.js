#!/usr/bin/env node
/**
 * Writes the Help Centre's content into help.html from help-content.js.
 *
 * WHY BUILD IT INTO THE PAGE
 * --------------------------
 * The FAQs are the page. Rendering them in the browser would mean a blank
 * page until the script ran, a jump when it did, and nothing at all for a
 * crawler or a phone with JavaScript off. So the markup is written into
 * help.html here, once, from the one content file - and the same pass writes
 * the FAQPage structured data from the same entries, so the visible answers
 * and the JSON-LD can never disagree. help.js then only adds behaviour.
 *
 * Content goes between marker comments in help.html:
 *   <!-- help:NAME:start --> ... <!-- help:NAME:end -->
 * Everything outside the markers is hand-written and left alone.
 *
 * USAGE
 *   node tools/build-help.js          rewrite help.html
 *   node tools/build-help.js --check  exit 1 if help.html is out of date
 *                                     (tests/test-help.js runs this)
 * `npm run build` runs it too.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'help.html');
const CHECK = process.argv.includes('--check');
const SITE = 'https://mwakete.com';

const C = require(path.join(ROOT, 'assets/js/help-content.js'));
const { mwaketeIcon } = require(path.join(ROOT, 'assets/js/help-icons.js'));
const T = C.HELP_STRINGS.en;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only same-site links and the support mailto are ever written. */
function safeHref(href) {
  const h = String(href || '');
  if (h === C.HELP_CONTACT_HREF) return h;
  if (/^[a-z0-9][a-z0-9\-/.]*\.html([?#][\w\-=&.%]*)?$/i.test(h)) return h;
  if (/^#[\w-]+$/.test(h)) return h;
  throw new Error('help-content.js: refusing to write link "' + h + '"');
}

const paragraphs = (text) => String(text).split(/\n\s*\n/).map((p) => '<p>' + esc(p.trim()) + '</p>').join('');

const byId = {};
C.HELP_FAQS.forEach((f) => { byId[f.id] = { kind: 'faq', e: f }; });
C.HELP_GUIDES.forEach((g) => { byId[g.id] = { kind: 'guide', e: g }; });

function anchorFor(id) {
  const ref = byId[id];
  if (!ref) throw new Error('help-content.js: related id "' + id + '" does not exist');
  if (ref.kind === 'faq') return '#faq-' + id;
  return ref.e.url ? ref.e.url : '#' + id;
}

function relatedBlock(ids) {
  if (!ids || !ids.length) return '';
  return '<div class="help-related"><p class="help-related-title">' + esc(T.relatedTitle) + '</p><ul>'
    + ids.map((id) => {
      const ref = byId[id];
      const label = (ref.kind === 'guide' ? T.badgeGuide + ': ' : '') + ref.e.title;
      return '<li><a href="' + esc(safeHref(anchorFor(id))) + '" data-help-link="' + esc(id) + '">'
        + mwaketeIcon('arrow', { size: 16 }) + '<span>' + esc(label) + '</span></a></li>';
    }).join('') + '</ul></div>';
}

function actionLink(action) {
  if (!action) return '';
  const href = safeHref(action.href);
  const ext = href.indexOf('mailto:') === 0;
  return '<p class="help-action"><a class="btn btn-light-purple" href="' + esc(href) + '"'
    + (ext ? ' data-help-contact' : '') + '>' + esc(action.label) + '</a></p>';
}

/** One accordion item. Used for FAQs and for guides shown in full. */
function accordionItem(kind, e, body) {
  const base = kind === 'faq' ? 'faq-' + e.id : e.id;
  return '<div class="help-acc" id="' + esc(base) + '" data-help-id="' + esc(e.id) + '" data-category="' + esc(e.category) + '">'
    + '<h4 class="help-acc-heading"><button type="button" class="help-acc-btn" id="' + esc(base) + '-btn"'
    + ' aria-expanded="false" aria-controls="' + esc(base) + '-panel">'
    + '<span class="help-acc-text"><span class="help-acc-title">' + esc(e.title) + '</span>'
    + '<span class="help-acc-sub">' + esc(e.subtitle) + '</span></span>'
    + '<span class="help-acc-sign" aria-hidden="true"></span></button></h4>'
    + '<div class="help-acc-panel" id="' + esc(base) + '-panel" role="region" aria-labelledby="' + esc(base) + '-btn">'
    + '<div class="help-acc-inner">' + body + '</div></div></div>';
}

function renderCategories() {
  return '<ul class="help-cat-grid">' + C.HELP_CATEGORIES.map((c) =>
    '<li><a class="help-cat" href="#topic-' + esc(c.id) + '" data-topic="' + esc(c.id) + '">'
    + '<span class="help-cat-icon">' + mwaketeIcon(c.icon, { size: 28 }) + '</span>'
    + '<span class="help-cat-text"><span class="help-cat-title">' + esc(c.title) + '</span>'
    + '<span class="help-cat-blurb">' + esc(c.blurb) + '</span></span></a></li>'
  ).join('') + '</ul>';
}

function renderFaqs() {
  return '<div class="help-faq-groups">' + C.HELP_CATEGORIES.map((c) => {
    const faqs = C.HELP_FAQS.filter((f) => f.category === c.id);
    if (!faqs.length) return '';
    return '<section class="help-faq-group" id="topic-' + esc(c.id) + '" data-category="' + esc(c.id) + '"'
      + ' aria-labelledby="topic-' + esc(c.id) + '-h">'
      + '<h3 class="help-group-title" id="topic-' + esc(c.id) + '-h">' + mwaketeIcon(c.icon, { size: 22 })
      + '<span>' + esc(c.title) + '</span></h3>'
      + faqs.map((f) => accordionItem('faq', f, paragraphs(f.description) + actionLink(f.action) + relatedBlock(f.related))).join('')
      + '</section>';
  }).join('') + '</div>';
}

function renderGuides() {
  return '<div class="help-guide-list">' + C.HELP_GUIDES.map((g) => {
    if (g.url) {
      return '<div class="help-acc help-acc--link" id="' + esc(g.id) + '" data-help-id="' + esc(g.id) + '" data-category="' + esc(g.category) + '">'
        + '<h4 class="help-acc-heading"><a class="help-acc-btn" href="' + esc(safeHref(g.url)) + '" data-help-link="' + esc(g.id) + '">'
        + '<span class="help-acc-text"><span class="help-acc-title">' + esc(g.title) + '</span>'
        + '<span class="help-acc-sub">' + esc(g.subtitle) + ' · ' + esc(T.minRead.replace('{n}', g.minutes)) + '</span></span>'
        + mwaketeIcon('arrow', { size: 20, className: 'help-acc-go' }) + '</a></h4></div>';
    }
    const body = '<p>' + esc(g.description) + ' <span class="help-meta">' + esc(T.minRead.replace('{n}', g.minutes)) + '</span></p>'
      + '<ol class="help-steps">' + g.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
      + actionLink(g.action) + relatedBlock(g.related);
    return accordionItem('guide', g, body);
  }).join('') + '</div>';
}

/** Generated from the same entries as the visible FAQs - never a second copy. */
function renderJsonLd() {
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: C.HELP_FAQS.map((f) => ({
      '@type': 'Question',
      name: f.title,
      acceptedAnswer: { '@type': 'Answer', text: f.description.replace(/\n\s*\n/g, ' ') }
    }))
  };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: T.breadcrumbHome, item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: T.breadcrumbHelp, item: SITE + '/help' }
    ]
  };
  // JSON inside <script>: "<" escaped so no string can close the tag early.
  const js = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  return '<script type="application/ld+json">' + js(faq) + '</script>\n'
    + '  <script type="application/ld+json">' + js(crumbs) + '</script>';
}

function validate() {
  const ids = new Set();
  const cats = new Set(C.HELP_CATEGORIES.map((c) => c.id));
  C.HELP_FAQS.concat(C.HELP_GUIDES).forEach((e) => {
    if (!/^[a-z0-9-]+$/.test(e.id)) throw new Error('bad id ' + e.id);
    if (ids.has(e.id)) throw new Error('duplicate id ' + e.id);
    ids.add(e.id);
    if (!cats.has(e.category)) throw new Error(e.id + ': unknown category ' + e.category);
    if (!e.title || !e.subtitle) throw new Error(e.id + ': title and subtitle are required');
  });
  (C.HELP_POPULAR_FAQS || []).forEach((id) => { if (!byId[id]) throw new Error('popular FAQ ' + id + ' missing'); });
}

function replaceBlock(html, name, content) {
  const re = new RegExp('(<!-- help:' + name + ':start -->)[\\s\\S]*?(<!-- help:' + name + ':end -->)');
  if (!re.test(html)) throw new Error('help.html: marker help:' + name + ' not found');
  return html.replace(re, (m, a, b) => a + '\n' + content + '\n' + b);
}

validate();
const before = fs.readFileSync(PAGE, 'utf8');
let html = before;
html = replaceBlock(html, 'jsonld', '  ' + renderJsonLd());
html = replaceBlock(html, 'categories', renderCategories());
html = replaceBlock(html, 'faqs', renderFaqs());
html = replaceBlock(html, 'guides', renderGuides());

if (CHECK) {
  if (html !== before) {
    console.error('help.html is out of date - run: node tools/build-help.js');
    process.exit(1);
  }
  console.log('help.html matches help-content.js.');
} else if (html !== before) {
  fs.writeFileSync(PAGE, html);
  console.log('help.html rebuilt.');
} else {
  console.log('help.html already up to date.');
}
