/**
 * Seller badges: the one place their labels, icons, explanations and styling
 * live.
 *
 * WHY THE METADATA IS HERE AND NOT IN THE API RESPONSE
 * ----------------------------------------------------
 * The backend sends only ids - `sellerBadges: ["recommended","verified"]`.
 * Everything a shopper reads is assembled here. A search page can carry 20
 * products from a dozen stores; sending each badge's label, icon markup and
 * one-sentence explanation alongside every one of them would repeat the same
 * few hundred bytes dozens of times per response, on a connection where the
 * whole point of the last round of work was getting the page under 1.5s. This
 * file is fetched once and service-worker cached.
 *
 * The cost of that split is drift: an id the backend awards that this file has
 * never heard of would silently vanish from the page. So Badges.gs holds the
 * same id list and a test asserts the two match, rather than trusting them to.
 *
 * WHY THE ICONS ARE INLINE SVG
 * ----------------------------
 * The same reason every other icon in this codebase is (helpers.js): no icon
 * library, no sprite sheet, no extra request per badge. They are drawn in the
 * same 24-unit box with a single 2px stroke as the phone, messenger and
 * delivery glyphs, so a badge sits beside them as part of one set.
 *
 * ICONS NEVER CARRY MEANING ALONE. Every badge renders its text label at every
 * size, and the shape/weight differences below survive monochrome and
 * forced-colours mode - see the .seller-badge block in styles.css.
 */

/* Priority order, highest first. This is the display order everywhere and the
   order a capped list is trimmed from, so a card showing two badges shows the
   two that matter most rather than the two that happened to come first. */
const SELLER_BADGE_ORDER = [
  'recommended', 'top', 'verified', 'responsive',
  'delivery', 'favourite', 'popular', 'new'
];

const BADGE_ICON_STAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"></path></svg>';

const BADGE_ICON_SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l8 3v6c0 4.5-3.2 8.6-8 10-4.8-1.4-8-5.5-8-10V5z"></path><path d="M9 12l2 2 4-4"></path></svg>';

// The same bubble as CHAT_NOTIFICATION_ICON_SVG in helpers.js, so "responds
// quickly to messages" and the chat button read as the same idea.
const BADGE_ICON_CHAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

// A parcel, deliberately NOT the truck glyph. The truck already means "this
// store delivers by truck" on every card; reusing it here would read as a
// delivery METHOD rather than a record of orders actually fulfilled.
const BADGE_ICON_PACKAGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8l-9-5-9 5v8l9 5z"></path><path d="M3.3 7.3 12 12l8.7-4.7"></path><path d="M12 12v9.5"></path></svg>';

const BADGE_ICON_HEART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"></path></svg>';

const BADGE_ICON_FLAME =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-9-1 2-2.5 2.5-3.5 4C10 8 9 6.5 9 5c-1.5 1.5-4 4-4 10a7 7 0 0 0 7 7z"></path></svg>';

// Four-point sparkle rather than a five-point star, so "new" is not mistaken
// for "top rated" at 12px where the two would otherwise be one blob.
const BADGE_ICON_SPARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3l1.7 4.8L17.5 9.5l-4.8 1.7L11 16l-1.7-4.8L4.5 9.5l4.8-1.7z"></path><path d="M18 15l.7 1.9 1.9.7-1.9.7L18 21l-.7-1.8-1.9-.7 1.9-.7z"></path></svg>';

/**
 * tier drives the SHAPE, category drives a restrained tint. Shape is what has
 * to survive a greyscale screenshot and forced-colours mode, so no badge is
 * ever distinguished by colour alone.
 *
 *   ribbon - Mwakete Recommended only. Notched tail, filled, elevated.
 *   shield - Verified Seller only. Squared chip with a solid left stripe.
 *   chip   - everything else. Pill, outlined.
 */
const SELLER_BADGES = {
  recommended: {
    label: 'Mwakete Recommended',
    explain: 'Recommended by Mwakete based on seller performance and customer experience.',
    tier: 'ribbon',
    category: 'trust',
    // The one emoji in the set, because the brief names this exact string.
    // aria-hidden, so a screen reader reads the label and not "trophy".
    icon: '<span class="seller-badge-emoji" aria-hidden="true">🏆</span>'
  },
  top: {
    label: 'Top Seller',
    explain: 'Consistently strong seller performance on Mwakete.',
    tier: 'star', category: 'performance', icon: BADGE_ICON_STAR
  },
  verified: {
    label: 'Verified Seller',
    explain: 'Store verified by Mwakete.',
    tier: 'shield', category: 'trust', icon: BADGE_ICON_SHIELD
  },
  responsive: {
    label: 'Responsive Seller',
    explain: 'Usually responds quickly to customer messages.',
    tier: 'chip', category: 'performance', icon: BADGE_ICON_CHAT
  },
  delivery: {
    label: 'Reliable Delivery',
    explain: 'Strong record of successful fulfilment.',
    tier: 'chip', category: 'performance', icon: BADGE_ICON_PACKAGE
  },
  favourite: {
    label: 'Customer Favourite',
    explain: 'Popular with returning and satisfied customers.',
    tier: 'chip', category: 'popularity', icon: BADGE_ICON_HEART
  },
  popular: {
    label: 'Popular Seller',
    explain: 'Currently receiving strong customer interest.',
    tier: 'chip', category: 'popularity', icon: BADGE_ICON_FLAME
  },
  new: {
    label: 'New Seller',
    explain: 'Recently joined Mwakete.',
    tier: 'chip', category: 'newcomer', icon: BADGE_ICON_SPARK
  }
};

/**
 * Priority order, duplicates and unknown ids removed.
 *
 * Dropping unknown ids is deliberate: a backend that starts awarding a badge
 * this build has never heard of must render nothing for it, not an empty chip
 * or the literal id. The drift test is what stops that state lasting.
 */
function sortSellerBadges(ids) {
  if (!Array.isArray(ids)) return [];
  const want = {};
  ids.forEach((id) => { if (SELLER_BADGES[id]) want[id] = true; });
  return SELLER_BADGE_ORDER.filter((id) => want[id]);
}

// Unique per page, so many badges can each own an id without the caller
// inventing one. Reset per page load, which is all the uniqueness ids need.
let sellerBadgeSeq = 0;

function sellerBadgeClasses(id, size) {
  const b = SELLER_BADGES[id];
  return 'seller-badge seller-badge--' + size
    + ' seller-badge--' + b.tier
    + ' seller-badge--cat-' + b.category
    + ' seller-badge--' + id;
}

/**
 * opts.size        'chip' (cards, search results) or 'detail' (product pages,
 *                  storefronts, admin). Both keep the text label.
 * opts.max         show at most this many; the rest go behind a "+N" control.
 * opts.interactive false renders plain spans with no popover.
 *
 * WHY interactive:false EXISTS. A product card is a single <a>. A <button>
 * inside an anchor is invalid HTML, and the browser's behaviour for a click on
 * it is not something to build an explanation on - it navigates. So cards get
 * badges that are read, not pressed, and the page carries ONE "What do seller
 * badges mean?" panel (renderBadgeLegend below) covering all of them. Product
 * pages and storefronts, where the badges are not inside a link, get a
 * per-badge popover.
 */
function renderSellerBadges(ids, opts) {
  opts = opts || {};
  const list = sortSellerBadges(ids);
  if (!list.length) return '';

  const size = opts.size === 'detail' ? 'detail' : 'chip';
  const interactive = opts.interactive !== false;
  const max = Number(opts.max) > 0 ? Number(opts.max) : list.length;
  const shown = list.slice(0, max);
  const hidden = list.slice(max);

  const one = (id) => {
    const b = SELLER_BADGES[id];
    const inner = b.icon + '<span class="seller-badge-label">' + escapeHtml(b.label) + '</span>';
    if (!interactive) {
      return '<span class="' + sellerBadgeClasses(id, size) + '">' + inner + '</span>';
    }
    const n = ++sellerBadgeSeq;
    return '<span class="seller-badge-wrap">'
      + '<button type="button" class="' + sellerBadgeClasses(id, size) + '"'
      + ' aria-expanded="false" aria-controls="sb-pop-' + n + '">' + inner + '</button>'
      + '<span class="info-pop seller-badge-pop" id="sb-pop-' + n + '" role="status" hidden>'
      + escapeHtml(b.explain) + '</span>'
      + '</span>';
  };

  let out = shown.map(one).join('');

  if (hidden.length) {
    // Named in full for a screen reader, counted for a thumb. On a card this is
    // not pressable (see above) - it says there is more to see on the product
    // page, which is where the tap was already going.
    const names = hidden.map((id) => SELLER_BADGES[id].label).join(', ');
    const label = '+' + hidden.length;
    const aria = hidden.length + ' more seller badge' + (hidden.length === 1 ? '' : 's') + ': ' + names;
    if (!interactive) {
      out += '<span class="seller-badge seller-badge--' + size + ' seller-badge--more"'
        + ' aria-label="' + escapeHtml(aria) + '">'
        + '<span class="seller-badge-label" aria-hidden="true">' + label + '</span></span>';
    } else {
      const n = ++sellerBadgeSeq;
      out += '<span class="seller-badge-wrap">'
        + '<button type="button" class="seller-badge seller-badge--' + size + ' seller-badge--more"'
        + ' aria-expanded="false" aria-controls="sb-pop-' + n + '">'
        + '<span class="seller-badge-label">' + label + '</span>'
        + '<span class="sr-only"> more seller badges</span></button>'
        + '<span class="info-pop seller-badge-pop" id="sb-pop-' + n + '" role="status" hidden>'
        + escapeHtml(aria) + '</span>'
        + '</span>';
    }
  }

  return '<span class="seller-badges" role="group" aria-label="Seller badges">' + out + '</span>';
}

/**
 * The reusable "Learn what seller badges mean" content: every badge, at chip
 * size, with its sentence. One of these per page beats repeating eight
 * explanations inside every card.
 *
 * A <dl> because that is what this is - terms and their definitions - so a
 * screen reader announces the pairing instead of sixteen loose lines.
 */
function renderBadgeLegend() {
  return '<dl class="badge-legend">'
    + SELLER_BADGE_ORDER.map((id) => {
      const b = SELLER_BADGES[id];
      return '<div class="badge-legend-row">'
        + '<dt>' + renderSellerBadges([id], { size: 'chip', interactive: false }) + '</dt>'
        + '<dd>' + escapeHtml(b.explain) + '</dd>'
        + '</div>';
    }).join('')
    + '</dl>';
}

/**
 * Attaches the disclosure to every interactive badge inside `root` (the whole
 * document by default). Safe to call again after re-rendering a list: badges
 * are replaced wholesale, so a fresh node never carries an old listener, and
 * `data-sb-wired` stops a node that survived from being wired twice.
 */
function wireSellerBadges(root) {
  const scope = root || document;
  scope.querySelectorAll('.seller-badge[aria-controls]').forEach((btn) => {
    if (btn.dataset.sbWired === '1') return;
    const pop = document.getElementById(btn.getAttribute('aria-controls'));
    if (!pop) return;
    wireInfoPop(btn, pop);
    btn.dataset.sbWired = '1';
  });
}
