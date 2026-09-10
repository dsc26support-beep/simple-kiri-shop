/* ===========================================================================
   A draggable floating chat button.

   THE HARD PART is not the dragging. It is telling a drag apart from a tap:
   the same finger, on the same 56px circle, means "move this" or "open the
   chat" depending on whether it travelled. Get it wrong and the button either
   refuses to open or opens every time it is nudged.

   The rule here: nothing is a drag until the pointer has moved DRAG_THRESHOLD
   pixels. Below that the browser's own click fires untouched, so the chat
   opens exactly as it always did. Above it, the click that the browser fires
   on release is swallowed, because a shopper who just moved the button did not
   ask to open it.

   ON RELEASE IT SNAPS to whichever side it is nearer. Free placement was the
   other option and it is worse: a button left in the middle of the screen sits
   on top of the product photo, the price, or Add to Cart, and it stays there
   on the next visit too. Snapping keeps it out of the way while still letting
   the shopper move it off whatever it was covering.

   The vertical position is free but clamped, so it can never be dragged behind
   the header or under the bottom navigation - the two places it would become
   untappable.

   Position is remembered per device in localStorage, and re-clamped on load:
   a position saved on a tall phone must not put the button off-screen on a
   short one, or after a rotation.
   =========================================================================== */

(function () {
  var STORAGE_KEY = 'mwakete_fab_pos';
  // Below this the gesture is a tap. 6px is about the wobble of a thumb on a
  // button press; a shopper who means to move it goes much further.
  var DRAG_THRESHOLD = 6;
  var EDGE_GAP = 12;

  var fab = null;
  var startX = 0, startY = 0;
  var grabDX = 0, grabDY = 0;
  var dragging = false;
  var moved = false;

  /** Space at the bottom the button must stay clear of: the nav bar, if shown. */
  function bottomReserved() {
    var nav = document.querySelector('.bottom-nav');
    if (!nav) return 0;
    // display:none above 700px, so measure rather than assume.
    var r = nav.getBoundingClientRect();
    return r.height > 0 && getComputedStyle(nav).position === 'fixed' ? r.height : 0;
  }

  /** Space at the top: the site header, when it is fixed or sticky. */
  function topReserved() {
    var header = document.querySelector('.site-header');
    if (!header) return 0;
    var pos = getComputedStyle(header).position;
    if (pos !== 'fixed' && pos !== 'sticky') return 0;
    return header.getBoundingClientRect().height;
  }

  /** Clamp a distance-from-bottom so the whole button stays reachable. */
  function clampBottom(bottom) {
    var h = fab.offsetHeight || 56;
    var min = bottomReserved() + EDGE_GAP;
    var max = window.innerHeight - h - topReserved() - EDGE_GAP;
    if (max < min) max = min;
    return Math.max(min, Math.min(max, bottom));
  }

  function save(pos) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch (e) {}
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || (p.side !== 'left' && p.side !== 'right')) return null;
      if (typeof p.bottom !== 'number' || !isFinite(p.bottom)) return null;
      return p;
    } catch (e) {
      // A private window, cleared site data, or a corrupt value. The button
      // keeps its CSS default, which is a working position.
      return null;
    }
  }

  /**
   * Apply a resting position. Written as left/right + bottom rather than
   * top/left so the button keeps behaving like the fixed, bottom-anchored
   * element the stylesheet expects.
   */
  function place(pos) {
    var bottom = clampBottom(pos.bottom);
    fab.style.bottom = bottom + 'px';
    if (pos.side === 'left') {
      fab.style.left = EDGE_GAP + 'px';
      fab.style.right = 'auto';
    } else {
      fab.style.right = EDGE_GAP + 'px';
      fab.style.left = 'auto';
    }
    fab.classList.add('fab-moved');
    return { side: pos.side, bottom: bottom };
  }

  function onPointerDown(e) {
    // Left button / touch / pen only. A right-click must not start a drag.
    if (e.button !== undefined && e.button !== 0) return;
    var r = fab.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    grabDX = e.clientX - r.left;
    grabDY = e.clientY - r.top;
    dragging = true;
    moved = false;
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onPointerMove(e) {
    if (!dragging) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;

    if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

    if (!moved) {
      moved = true;
      // Only now does this become a drag. touch-action:none in the class stops
      // the page scrolling under the finger for the rest of the gesture.
      fab.classList.add('is-dragging');
    }

    // While dragging, position from the top-left corner - it is the only frame
    // in which "follow the finger" is one subtraction. It goes back to
    // right/bottom on release.
    var w = fab.offsetWidth;
    var h = fab.offsetHeight;
    var left = Math.max(0, Math.min(window.innerWidth - w, e.clientX - grabDX));
    var top = Math.max(0, Math.min(window.innerHeight - h, e.clientY - grabDY));
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!moved) return;              // a tap - leave the click alone

    fab.classList.remove('is-dragging');
    var r = fab.getBoundingClientRect();
    var side = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
    var bottom = window.innerHeight - r.bottom;
    fab.style.top = 'auto';
    save(place({ side: side, bottom: bottom }));
  }

  /**
   * Swallow the click the browser fires after a drag.
   *
   * On DOCUMENT, in the capture phase - and that placement is the whole point.
   * chat-window.js registers its own click listener on this same button, and
   * it registers first because its script tag comes first. Listeners on the
   * TARGET element all fire in registration order, capture flag or not, so a
   * capture listener on the button itself still runs second - after the chat
   * has already opened. Capturing at the document runs before the event
   * reaches the button at all, which is the only place this can win from.
   *
   * Found by a test: dragging the button opened the chat every time.
   */
  function onDocumentClickCapture(e) {
    if (!moved) return;
    if (!fab.contains(e.target) && e.target !== fab) return;
    moved = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function init() {
    fab = document.getElementById('chat-fab');
    if (!fab || !window.PointerEvent) return;

    var saved = load();
    if (saved) place(saved);

    fab.addEventListener('pointerdown', onPointerDown);
    fab.addEventListener('pointermove', onPointerMove);
    fab.addEventListener('pointerup', onPointerUp);
    fab.addEventListener('pointercancel', function () {
      dragging = false;
      moved = false;
      fab.classList.remove('is-dragging');
    });
    document.addEventListener('click', onDocumentClickCapture, true);

    // A rotation or a resized window can put a saved position off-screen, or
    // leave it sitting where the bottom nav has just appeared.
    window.addEventListener('resize', function () {
      if (!fab.classList.contains('fab-moved')) return;
      var s = load();
      if (s) place(s);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
