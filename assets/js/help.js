/**
 * Help Centre behaviour (help.html).
 *
 * The FAQs, guides and topic cards are already in the page - written there by
 * tools/build-help.js from help-content.js - so this file only adds behaviour:
 *
 *   - the accordion (real <button>s, aria-expanded, keyboard and touch)
 *   - one unified search over FAQs, guides and blog posts (help-search.js),
 *     debounced, with type and topic filters
 *   - deep links: help.html#faq-<id> opens that answer, ?q= runs a search
 *   - the zero-result state, which always leads somewhere
 *
 * Nothing here talks to the backend. The knowledge base ships with the page,
 * so search works offline and costs no request. Every string that reaches the
 * DOM from content goes through escapeHtml, or escapeAttr inside an attribute
 * (helpers.js); links come only from
 * the search index, which builds them from ids, never from the query.
 */
document.addEventListener('DOMContentLoaded', initHelpCentre);

const HELP_DEBOUNCE_MS = 150;

function helpText() {
  const lang = (document.documentElement.lang || 'en').slice(0, 3);
  return Object.assign({}, HELP_STRINGS.en, HELP_STRINGS[lang] || {});
}

const helpState = { q: '', type: 'all', topic: '' };
let helpIndex = [];
let helpT = null;

function initHelpCentre() {
  helpT = helpText();
  wireAccordions(document);

  try {
    helpIndex = HelpSearch.build({
      categories: HELP_CATEGORIES, faqs: HELP_FAQS, guides: HELP_GUIDES, blog: HELP_BLOG_POSTS
    });
  } catch (e) {
    // The FAQs are still on the page and still open and close; only search
    // is lost. Say so instead of offering a box that silently does nothing.
    helpIndex = null;
  }

  renderPopularSearches();
  renderFilters();
  wireSearch();
  wireTopicCards();
  wireHelpLinks();

  const params = new URLSearchParams(location.search);
  const q = (params.get('q') || '').slice(0, 200);
  const topic = params.get('topic') || '';
  if (HELP_CATEGORIES.some((c) => c.id === topic)) helpState.topic = topic;
  if (q) {
    document.getElementById('help-q').value = q;
    helpState.q = q;
  }
  applyState(false);
  if (!q && location.hash) openFromHash(location.hash, false);
  window.addEventListener('hashchange', () => openFromHash(location.hash, true));
}

/* ---------------- accordion ---------------- */

function setOpen(item, open, opts) {
  const btn = item.querySelector('button.help-acc-btn');
  if (!btn) return;
  item.classList.toggle('is-open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && opts && opts.scroll) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    item.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  if (open && opts && opts.focus) btn.focus({ preventScroll: true });
}

function wireAccordions(root) {
  root.querySelectorAll('.help-acc').forEach((item) => {
    const btn = item.querySelector('button.help-acc-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      setOpen(item, btn.getAttribute('aria-expanded') !== 'true');
    });
  });
}

/** #faq-<id> or #guide-<id>: show the browse view, open it, bring it into view. */
function openFromHash(hash, fromNavigation) {
  const id = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  if (!/^[\w-]+$/.test(id)) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('help-acc')) {
    if (helpState.q || helpState.topic || helpState.type !== 'all') resetSearch();
    setOpen(el, true, { scroll: true, focus: fromNavigation });
  } else if (el.classList.contains('help-faq-group')) {
    el.scrollIntoView({ block: 'start' });
  }
}

/* ---------------- popular searches + filters ---------------- */

function chip(label, attrs, pressed) {
  return '<button type="button" class="help-chip"' + attrs
    + (pressed == null ? '' : ' aria-pressed="' + (pressed ? 'true' : 'false') + '"') + '>'
    + escapeHtml(label) + '</button>';
}

function renderPopularSearches() {
  const list = document.getElementById('help-popular-list');
  list.innerHTML = HELP_POPULAR_SEARCHES.map((s) => chip(s, ' data-help-search="' + escapeAttr(s) + '"')).join('');
}

function helpTypes() {
  const types = [['all', helpT.typeAll], ['faq', helpT.typeFaq], ['guide', helpT.typeGuide]];
  // No blog yet: no Blog filter that could only ever show nothing.
  if (HELP_BLOG_POSTS.length) types.push(['blog', helpT.typeBlog]);
  return types;
}

function renderFilters() {
  document.getElementById('help-type-filters').innerHTML = helpTypes()
    .map(([id, label]) => chip(label, ' data-help-type="' + id + '"', helpState.type === id)).join('');
  document.getElementById('help-topic-filters').innerHTML =
    chip(helpT.topicAll, ' data-help-topic=""', !helpState.topic)
    + HELP_CATEGORIES.filter((c) => c.filter !== false)
      .map((c) => chip(shortTopic(c), ' data-help-topic="' + escapeAttr(c.id) + '"', helpState.topic === c.id)).join('');
}

/** "Buying on Mwakete" reads long on a chip; the first word does the job. */
function shortTopic(c) {
  return c.title.replace(/ on Mwakete$/, '').replace(/ & .*$/, '');
}

function syncFilterButtons() {
  document.querySelectorAll('[data-help-type]').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.helpType === helpState.type ? 'true' : 'false'));
  document.querySelectorAll('[data-help-topic]').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.helpTopic === helpState.topic ? 'true' : 'false'));
  document.querySelectorAll('.help-cat').forEach((a) =>
    a.classList.toggle('is-active', a.dataset.topic === helpState.topic));
}

/* ---------------- search ---------------- */

function wireSearch() {
  const form = document.getElementById('help-search-form');
  const input = document.getElementById('help-q');
  const clear = document.getElementById('help-q-clear');
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    clear.hidden = !input.value;
    timer = setTimeout(() => { helpState.q = input.value.slice(0, 200); applyState(true); }, HELP_DEBOUNCE_MS);
  });
  // Enter / the keyboard's Search key: search now, and drop the keyboard so
  // the results are visible on a phone.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    helpState.q = input.value.slice(0, 200);
    applyState(true);
    input.blur();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); resetSearch(); }
  });
  clear.addEventListener('click', () => { resetSearch(); input.focus(); });

  document.addEventListener('click', (e) => {
    const pop = e.target.closest('[data-help-search]');
    if (pop) {
      input.value = pop.dataset.helpSearch;
      clear.hidden = false;
      helpState.q = input.value;
      applyState(true);
      return;
    }
    const typeBtn = e.target.closest('[data-help-type]');
    if (typeBtn) { helpState.type = typeBtn.dataset.helpType; applyState(true); return; }
    const topicBtn = e.target.closest('[data-help-topic]');
    if (topicBtn && topicBtn.tagName === 'BUTTON') {
      helpState.topic = topicBtn.dataset.helpTopic;
      if (topicBtn.hasAttribute('data-help-clear-filters')) helpState.type = 'all';
      applyState(true);
    }
  });
}

function resetSearch() {
  const input = document.getElementById('help-q');
  input.value = '';
  document.getElementById('help-q-clear').hidden = true;
  helpState.q = '';
  helpState.type = 'all';
  helpState.topic = '';
  applyState(true);
}

/** Topic cards: filter to that topic instead of only jumping to it. */
function wireTopicCards() {
  document.querySelectorAll('.help-cat').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      helpState.topic = helpState.topic === a.dataset.topic ? '' : a.dataset.topic;
      applyState(true);
      if (helpState.topic) {
        const group = document.getElementById('topic-' + helpState.topic);
        const target = group || document.getElementById('faq');
        if (target) target.scrollIntoView({ block: 'start' });
      }
    });
  });
}

/** In-page "Related" links: open the answer they point at. */
function wireHelpLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const hash = a.getAttribute('href');
    if (!/^#(faq-|guide-)/.test(hash)) return;
    e.preventDefault();
    if (location.hash !== hash) history.pushState(null, '', hash);
    openFromHash(hash, true);
  });
}

function applyState(updateUrl) {
  // Letters or digits make a search; "???" alone is an empty box.
  const searching = typeof HelpSearch !== 'undefined' ? !!HelpSearch.fold(helpState.q) : !!helpState.q.trim();
  // Hidden in the markup so a page without JavaScript shows no dead buttons.
  document.getElementById('help-filters').hidden = false;
  syncFilterButtons();

  const results = document.getElementById('help-results');
  const browse = document.getElementById('help-browse');
  if (searching) {
    browse.hidden = true;
    results.hidden = false;
    renderResults();
  } else {
    results.hidden = true;
    browse.hidden = false;
    filterBrowse();
    document.getElementById('help-status').textContent = '';
  }
  if (updateUrl) syncUrl();
}

/** With no query, topic and type filters narrow the browse view in place. */
function filterBrowse() {
  const t = helpState.topic;
  document.querySelectorAll('#help-browse .help-faq-group').forEach((g) => {
    g.hidden = !!t && g.dataset.category !== t;
  });
  let guidesShown = 0;
  document.querySelectorAll('#help-browse .help-guide-list .help-acc').forEach((g) => {
    const show = !t || g.dataset.category === t;
    g.hidden = !show;
    if (show) guidesShown++;
  });
  document.getElementById('faq').hidden = helpState.type === 'guide' || helpState.type === 'blog';
  document.getElementById('guides').hidden = helpState.type === 'faq' || helpState.type === 'blog' || !guidesShown;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (helpState.q.trim()) params.set('q', helpState.q.trim());
  if (helpState.topic) params.set('topic', helpState.topic);
  const qs = params.toString();
  const url = location.pathname + (qs ? '?' + qs : '') + (qs ? '' : location.hash);
  try { history.replaceState(null, '', url); } catch (e) { /* file:// or sandboxed: fine */ }
}

function typeLabel(type) {
  return type === 'faq' ? helpT.badgeFaq : type === 'guide' ? helpT.badgeGuide : helpT.badgeBlog;
}

/** Links are built by the index from ids; anything else is refused. */
function safeResultHref(url) {
  const u = String(url || '');
  return /^(help\.html#[\w-]+|[a-z0-9][a-z0-9\-/]*\.html([?#][\w\-=&.%]*)?)$/i.test(u) ? u : 'help.html';
}

function resultCard(item) {
  const meta = [];
  if (item.categoryTitle) meta.push(escapeHtml(item.categoryTitle));
  if (item.minutes) meta.push(escapeHtml(helpT.minRead.replace('{n}', item.minutes)));
  if (item.publishedAt) meta.push(escapeHtml(item.publishedAt));
  let href = safeResultHref(item.url);
  // A result for something on THIS page links to its anchor, so following it
  // opens the answer without a reload.
  if (href.indexOf('help.html#') === 0) href = href.slice('help.html'.length);
  return '<li><a class="help-result help-result--' + escapeAttr(item.type) + '" href="' + escapeAttr(href) + '" data-help-result="' + escapeAttr(item.id) + '">'
    + '<span class="help-type-badge help-type-badge--' + escapeAttr(item.type) + '">' + escapeHtml(typeLabel(item.type)) + '</span>'
    + '<span class="help-result-title">' + escapeHtml(item.title) + '</span>'
    + (item.subtitle ? '<span class="help-result-sub">' + escapeHtml(item.subtitle) + '</span>' : '')
    + '<span class="help-result-desc">' + escapeHtml(item.description.replace(/\s*\n\s*\n\s*/g, ' ')) + '</span>'
    + (meta.length ? '<span class="help-result-meta">' + meta.join(' · ') + '</span>' : '')
    + '</a></li>';
}

function renderResults() {
  const list = document.getElementById('help-results-list');
  const none = document.getElementById('help-noresults');
  const heading = document.getElementById('help-results-h');
  const status = document.getElementById('help-status');
  const q = helpState.q.trim();

  if (!helpIndex) {
    list.innerHTML = '';
    heading.textContent = helpT.searchFailed;
    none.hidden = true;
    status.textContent = helpT.searchFailed;
    return;
  }

  let found;
  try {
    found = HelpSearch.search(helpIndex, q, { type: helpState.type, topic: helpState.topic });
  } catch (e) {
    found = null;
  }
  if (!found) {
    list.innerHTML = '';
    heading.textContent = helpT.searchFailed;
    none.hidden = true;
    status.textContent = helpT.searchFailed;
    return;
  }

  const count = found.length === 1 ? helpT.resultsOne : helpT.resultsMany.replace('{n}', found.length);
  heading.textContent = count + ' ' + helpT.resultsFor.replace('{q}', q);
  status.textContent = heading.textContent;

  if (!found.length) {
    list.innerHTML = '';
    none.hidden = false;
    none.innerHTML = noResultsHtml();
    return;
  }
  none.hidden = true;
  list.innerHTML = found.map((r) => resultCard(r.item)).join('');
}

/** Never a dead end: other searches, popular answers, and (below) a person to ask. */
function noResultsHtml() {
  const popular = HELP_POPULAR_FAQS
    .map((id) => helpIndex.find((it) => it.type === 'faq' && it.id === id))
    .filter(Boolean);
  const filtered = helpState.topic || helpState.type !== 'all';
  return '<p class="help-noresults-title">' + escapeHtml(helpT.noMatchTitle) + '</p>'
    + (filtered ? '<p><button type="button" class="help-chip" data-help-topic="" data-help-clear-filters>' + escapeHtml(helpT.topicAll) + '</button></p>' : '')
    + '<p class="help-noresults-try">' + escapeHtml(helpT.noMatchTry) + '</p>'
    + '<div class="help-chip-row">' + ['delivery', 'selling', 'payment', 'store', 'account']
      .map((s) => chip(s, ' data-help-search="' + escapeAttr(s) + '"')).join('') + '</div>'
    + '<p class="help-noresults-try">' + escapeHtml(helpT.noMatchPopular) + '</p>'
    + '<ul class="help-result-list">' + popular.map(resultCard).join('') + '</ul>';
  // ...and the "Still need help?" contact section sits directly below.
}
