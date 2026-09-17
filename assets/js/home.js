document.addEventListener('DOMContentLoaded', init);

function init() {
  // Both strips come from the shared taxonomy and need no backend at all, so
  // they are on screen with the first paint rather than after a round trip.
  renderCategoryStrip('category-strip');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  startSearchPrompts();
  startVoiceSearch();
  loadHomePageData();
}

/**
 * The microphone at the right of the home search box.
 *
 * Browser-native (the Web Speech API), so no backend, no key and no per-use
 * cost. It fills the search box with what was said and runs the search.
 *
 * ENGLISH ONLY, AND IT SAYS SO. Browser speech recognition supports a fixed
 * list of languages and te taetae ni Kiribati is not on it - somebody speaking
 * Kiribati would get nonsense back rather than an error. The button's name and
 * its hint both say "speak in English" so that is discovered before use rather
 * than after. Typing Kiribati still works; the smart search in search-intent.js
 * reads it.
 *
 * HIDDEN WHERE IT CANNOT WORK. The button ships hidden and is only revealed
 * once the API is confirmed present, so nobody is offered a control that does
 * nothing. It is in the markup rather than created here so that revealing it
 * cannot move the bar after first paint.
 */
function startVoiceSearch() {
  const btn = document.getElementById('voice-search-btn');
  const input = document.getElementById('search-input');
  const status = document.getElementById('voice-search-status');
  if (!btn || !input) return;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;            // stays hidden

  btn.hidden = false;

  let listening = false;
  let recognition = null;

  const say = (msg) => { if (status) status.textContent = msg; };

  const stopListening = (msg) => {
    listening = false;
    btn.classList.remove('is-listening');
    btn.setAttribute('aria-pressed', 'false');
    say(msg || '');
  };

  btn.setAttribute('aria-pressed', 'false');

  btn.addEventListener('click', () => {
    // Second tap cancels. A microphone with no way to turn it off is a
    // microphone somebody will avoid using at all.
    if (listening && recognition) {
      recognition.abort();
      stopListening('Stopped listening.');
      return;
    }

    recognition = new Recognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.addEventListener('start', () => {
      listening = true;
      btn.classList.add('is-listening');
      btn.setAttribute('aria-pressed', 'true');
      say('Listening. Speak in English.');
    });

    recognition.addEventListener('result', (e) => {
      const said = (e.results && e.results[0] && e.results[0][0] || {}).transcript || '';
      const q = said.trim();
      stopListening(q ? 'Heard: ' + q : '');
      if (!q) return;
      input.value = q;
      // The prompt rotation stops on input; this is input, so tell it.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('search-form').requestSubmit();
    });

    // A refused microphone is the common case, not an edge case: it is one
    // mis-tap on a permission sheet, and it must not leave the button stuck
    // looking live.
    recognition.addEventListener('error', (e) => {
      const why = e && e.error;
      if (why === 'not-allowed' || why === 'service-not-allowed') {
        stopListening('Microphone blocked. Allow microphone access to search by voice.');
      } else if (why === 'no-speech') {
        stopListening('Did not catch that.');
      } else {
        stopListening('Voice search is not available right now.');
      }
    });

    recognition.addEventListener('end', () => { if (listening) stopListening(''); });

    try {
      recognition.start();
    } catch (err) {
      stopListening('Voice search is not available right now.');
    }
  });
}

/**
 * Three prompts in the home search box, one at a time.
 *
 * Home only. The other three search boxes say what they actually search
 * ("Search this category…"), which tells a shopper more than a general
 * question would.
 *
 * Three rules this follows, none of them optional:
 *
 * 1. THE ACCESSIBLE NAME DOES NOT ROTATE. A placeholder is part of what a
 *    screen reader announces for a field, so a rotating one is a field that
 *    renames itself every few seconds while someone is still deciding what to
 *    type. An aria-label is set once and stays; the rotation is then purely
 *    visual and reaches nobody who is listening.
 *
 * 2. IT STOPS THE MOMENT THEY ENGAGE. A prompt that changes while a shopper is
 *    reading it is the prompt moving out from under them.
 *
 * 3. REDUCED MOTION GETS ONE PROMPT AND NO TIMER. Text that changes on its own
 *    is motion, whatever else it is.
 *
 * Nothing here can shift the layout: the input's width comes from the flex row,
 * not from its text, so the box is the same size whichever prompt is showing.
 */
const SEARCH_PROMPTS = [
  'What is on your mind?',
  'Ask Mwakete…',
  'Try using Kiribati language.'
];

const SEARCH_PROMPT_MS = 3500;

function startSearchPrompts() {
  const input = document.getElementById('search-input');
  if (!input) return;

  input.setAttribute('aria-label', 'Search products, services and rentals');
  input.placeholder = SEARCH_PROMPTS[0];

  const reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % SEARCH_PROMPTS.length;
    input.placeholder = SEARCH_PROMPTS[i];
  }, SEARCH_PROMPT_MS);

  const stop = () => clearInterval(timer);
  input.addEventListener('focus', stop, { once: true });
  input.addEventListener('input', stop, { once: true });
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `categories.html?q=${encodeURIComponent(q)}`;
}

// One combined request for both sections below, instead of two separate
// round trips - Apps Script's own per-request execution-startup overhead
// is the dominant cost for a page load like this, so halving the number of
// round trips is what actually moves the needle on "page feels slow," not
// anything about the Sheets reads themselves (both halves are still served
// from the same 300s caches actionListTopProducts/actionListTopStores use).
async function loadHomePageData() {
  const productsStatusEl = document.getElementById('trending-products-status');
  const storesStatusEl = document.getElementById('trending-stores-status');
  const stopProductsLoading = startLoadingMessage(productsStatusEl);
  const stopStoresLoading = startLoadingMessage(storesStatusEl);

  const request = Api.get('getHomePageData', {});
  // The request this page paints from; whenIdle() waits for it (helpers.js).
  window.__criticalReady = request;
  const res = await request;
  stopProductsLoading();
  stopStoresLoading();
  if (!res.ok) {
    showLoadFailedMessage(productsStatusEl);
    showLoadFailedMessage(storesStatusEl);
    return;
  }
  renderTrendingProducts(res.products);
  renderTrendingStores(res.stores);
}

function renderTrendingProducts(products) {
  const statusEl = document.getElementById('trending-products-status');
  const listEl = document.getElementById('trending-products-list');

  if (products.length === 0) {
    statusEl.textContent = 'No products yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = products.map((p) => renderBrowseProductCard(p, { showLocation: true })).join('');
  // Card badges cannot carry their own popover (they are inside the card's
  // link), so the page explains them once. Renders nothing when no card on the
  // page has a badge - which on a young marketplace is most pages.
  mountBadgeLegend('home-badge-legend', products);
  recordProductViewsOnce(products.map((p) => p.productId));
}

function renderTrendingStores(stores) {
  const statusEl = document.getElementById('trending-stores-status');
  const listEl = document.getElementById('trending-stores-list');

  if (stores.length === 0) {
    statusEl.textContent = 'No stores yet.';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = stores.map(renderLogoCarouselItem).join('');
}
