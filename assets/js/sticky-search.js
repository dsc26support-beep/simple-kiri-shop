/**
 * The search bar never scrolls out of sight (owner requests, Oct 2026: first
 * computers, then phones and tablets too). Once it reaches the top it is
 * pinned there, on a white strip, just under whatever stays on screen above
 * it - the red header on a computer, the yellow strip on a phone or tablet
 * home page - or at the very top where nothing does. A spacer of the same
 * height takes its place so nothing below moves.
 *
 * Used on the pages with a main search box (form.search-box): home, Stores,
 * Categories and a storefront. Help has its own sticky bar.
 */
(function () {
  function init() {
    var form = document.querySelector('form.search-box[role="search"]');
    if (!form) return;
    var spacer = document.createElement('div');
    spacer.className = 'search-pin-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    form.parentNode.insertBefore(spacer, form);
    // The bars that can stay on screen above the search: the red header (sticky
    // on a computer) and the yellow strip (sticky on phones and tablets).
    var bars = [document.querySelector('header.site-header'), document.querySelector('.header-ticker')]
      .filter(Boolean);
    var pinned = false;
    var queued = false;

    // How far down the pinned bar sits: below the lowest bar that stays on
    // screen (sticky and showing), otherwise at the very top - plus the white
    // strip's own margin above the box.
    var GAP = 8;
    function pinTop() {
      var bottom = 0;
      bars.forEach(function (bar) {
        var cs = getComputedStyle(bar);
        if (cs.position !== 'sticky' || cs.display === 'none') return;
        bottom = Math.max(bottom, bar.getBoundingClientRect().bottom);
      });
      return bottom + GAP;
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
    update();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
