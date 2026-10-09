// The homepage header strip (red on desktop, yellow on phones): adverts set
// on the admin dashboard (backend HeaderAds.gs), or - with none running -
// the three built-in lines in index.html.
//
// Each line slides in from the right, stays still for 6 seconds so it can be
// read and tapped, then slides out to the left. Paused while hovered or
// focused, and while the tab is hidden. Reduced motion: lines change without
// sliding.
//
// The last adverts seen are remembered on this device, so a returning shopper
// sees them at once instead of the defaults flashing first; the backend is
// then asked again when the page is idle.
const HeaderAds = (() => {
  const HOLD_MS = 6000;
  const SLIDE_MS = 600;
  const STORE_KEY = 'skiri_header_ads';
  let timer = null;
  let paused = false;

  const strip = () => document.querySelector('.header-ticker');

  function isSafeLink(link) {
    return /^https:\/\/[^\s<>"']+$/i.test(link) || /^(index|store|stores|product|categories|recent|help)\.html(\?[^\s<>"']*)?$/i.test(link);
  }

  function render(ads) {
    const el = strip();
    if (!el) return;
    const list = (ads || []).filter((a) => a && a.text && isSafeLink(String(a.link || '')));
    if (!list.length) return;   // keep the built-in lines
    el.innerHTML = list.map((a, i) => {
      const external = /^https:/i.test(a.link) && a.link.indexOf(location.origin) !== 0;
      return `<div class="header-ticker-item${i === 0 ? ' is-current' : ''}"><a class="header-ticker-link" href="${escapeHtml(a.link)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(a.text)}<span aria-hidden="true"> ›</span></a></div>`;
    }).join('');
    // Adverts are links people can use, so the strip is no longer decorative.
    el.removeAttribute('aria-hidden');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Adverts');
    syncFocus();
    restart();
  }

  /** Only the advert on screen can be reached by keyboard or screen reader. */
  function syncFocus() {
    const el = strip();
    el.querySelectorAll('.header-ticker-item').forEach((item) => {
      const on = item.classList.contains('is-current');
      item.setAttribute('aria-hidden', String(!on));
      const a = item.querySelector('a');
      if (a) a.tabIndex = on ? 0 : -1;
    });
  }

  function next() {
    const el = strip();
    const items = Array.from(el.querySelectorAll('.header-ticker-item'));
    if (items.length < 2) return;
    const i = items.findIndex((x) => x.classList.contains('is-current'));
    const cur = items[i === -1 ? 0 : i];
    const nxt = items[((i === -1 ? 0 : i) + 1) % items.length];
    items.forEach((x) => x.classList.remove('is-leaving'));
    // The next line starts off-screen to the right, without animating there.
    nxt.classList.add('is-ready');
    void nxt.offsetWidth;
    nxt.classList.remove('is-ready');
    cur.classList.remove('is-current');
    cur.classList.add('is-leaving');
    nxt.classList.add('is-current');
    syncFocus();
  }

  function tick() {
    timer = setTimeout(() => {
      if (!paused && !document.hidden) next();
      tick();
    }, HOLD_MS + SLIDE_MS);
  }

  function restart() {
    clearTimeout(timer);
    tick();
  }

  function init() {
    const el = strip();
    if (!el) return;
    el.classList.add('header-ticker--slide');
    const first = el.querySelector('.header-ticker-item');
    if (first && !el.querySelector('.is-current')) first.classList.add('is-current');
    el.addEventListener('mouseenter', () => { paused = true; });
    el.addEventListener('mouseleave', () => { paused = false; });
    el.addEventListener('focusin', () => { paused = true; });
    el.addEventListener('focusout', () => { paused = false; });

    let remembered = null;
    try { remembered = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { remembered = null; }
    if (Array.isArray(remembered) && remembered.length) render(remembered);
    else restart();

    whenIdle(async () => {
      const res = await Api.get('getHeaderAds', {});
      if (!res || !res.ok || !Array.isArray(res.ads)) return;   // offline / older backend: keep what is showing
      try { localStorage.setItem(STORE_KEY, JSON.stringify(res.ads)); } catch (e) { /* storage full - fine */ }
      if (res.ads.length) {
        if (JSON.stringify(res.ads) !== JSON.stringify(remembered)) render(res.ads);
      } else if (remembered && remembered.length) {
        restoreDefaults();
      }
    });
  }

  // Adverts were remembered but none are running now: back to the built-in lines.
  function restoreDefaults() {
    const el = strip();
    el.innerHTML = HEADER_AD_DEFAULTS.map((t, i) => `<div class="header-ticker-item${i === 0 ? ' is-current' : ''}">${escapeHtml(t)}</div>`).join('');
    el.setAttribute('aria-hidden', 'true');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    restart();
  }

  return { init, render };
})();

// Same three lines as index.html's markup.
const HEADER_AD_DEFAULTS = ['Local Kiribati sellers', 'Chat directly with the seller', 'Delivery, shipping & pickup options'];

document.addEventListener('DOMContentLoaded', () => HeaderAds.init());
