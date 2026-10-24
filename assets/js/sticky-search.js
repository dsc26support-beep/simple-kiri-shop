/**
 * On a computer the search bar never scrolls out of sight (owner request,
 * Oct 2026). Once it reaches the top it is pinned there - just under the red
 * header on the home page, where the header itself stays on screen - on a
 * white strip, and a spacer of the same height takes its place so nothing
 * below moves. Phones and tablets keep their usual scrolling: a pinned bar
 * would eat too much of a small screen.
 *
 * Used on the pages with a main search box (form.search-box): home, Stores,
 * Categories and a storefront. Help has its own sticky bar.
 */
(function () {
  var DESKTOP = window.matchMedia('(min-width: 1025px)');

  function init() {
    var form = document.querySelector('form.search-box[role="search"]');
    if (!form) return;
    var spacer = document.createElement('div');
    spacer.className = 'search-pin-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    form.parentNode.insertBefore(spacer, form);
    var header = document.querySelector('header.site-header');
    var pinned = false;
    var queued = false;

    // How far down the pinned bar sits: below the header where the header
    // itself stays on screen (sticky), otherwise at the very top - plus the
    // white strip's own margin above the box.
    var GAP = 8;
    function pinTop() {
      if (!header || getComputedStyle(header).position !== 'sticky') return GAP;
      return Math.max(0, header.getBoundingClientRect().bottom) + GAP;
    }

    function setPinned(on, top) {
      if (on === pinned) {
        if (on) form.style.top = top + 'px';
        return;
      }
      pinned = on;
      spacer.style.height = on ? form.offsetHeight + 'px' : '';
      form.style.top = on ? top + 'px' : '';
      form.classList.toggle('is-pinned', on);
    }

    function update() {
      queued = false;
      if (!DESKTOP.matches) { setPinned(false); return; }
      var top = pinTop();
      // The spacer marks where the bar lives in the page, pinned or not.
      setPinned(spacer.getBoundingClientRect().top < top, top);
    }

    function queue() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    }

    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    if (DESKTOP.addEventListener) DESKTOP.addEventListener('change', queue);
    update();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
