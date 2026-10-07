/**
 * Mwakete icons: one small, original SVG set.
 *
 * ONE VISUAL LANGUAGE. Every icon is drawn in the same 24-unit box with a
 * single 2px rounded stroke and no fill - the same rules the site's existing
 * glyphs follow (helpers.js, header-menu.js, badges.js), so a Help Centre icon
 * sits beside a delivery or menu icon as part of one family. No icon font, no
 * library, no extra request: each is a few hundred bytes of markup.
 *
 * The island motifs are deliberate but quiet - a wave inside the search lens
 * and the shield, a canoe under the parcel, two islands joined by a route -
 * so the set reads as Mwakete's own without becoming a postcard.
 *
 * Colour comes from `currentColor`, so an icon follows the text colour of
 * wherever it is placed, on light or dark backgrounds alike.
 *
 * Used by help.js in the browser and by tools/build-help.js at build time
 * (which writes the category grid into help.html), so both draw from here.
 */
const MWAKETE_ICON_PATHS = {
  // Lens with a wave in it: "search" with a sea horizon.
  search: '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.4 15.4 20 20"></path><path d="M7.4 11.2c1-.9 2.1-.9 3.1 0s2.1.9 3.1 0"></path>',
  // A palm on an island, a smaller island beyond: "where it all happens".
  islands: '<path d="M2.5 19.5c2.6-3.2 9.4-3.2 12 0"></path><path d="M15.5 19.5c1.4-1.8 4.6-1.8 6 0"></path><path d="M8.5 17.2c-.2-3.4.4-6.4 2-9"></path><path d="M10.5 8.2C9 6.6 6.4 6.5 4.8 8"></path><path d="M10.5 8.2c1.6-1.5 4.2-1.3 5.6.4"></path><path d="M10.5 8.2c.2-2-1-3.6-2.9-4"></path>',
  // A market basket with a parcel inside.
  buying: '<path d="M3.5 10h17l-1.6 9.2a1 1 0 0 1-1 .8H6.1a1 1 0 0 1-1-.8z"></path><path d="M8 10l2.5-5.5M16 10l-2.5-5.5"></path><path d="M10 13.5h4v3.5h-4z"></path>',
  // A storefront with its door standing open.
  selling: '<path d="M4 10.5V20h16v-9.5"></path><path d="M2.5 10.5 5 4h14l2.5 6.5z"></path><path d="M10 20v-5.5h4.5L12 16v4"></path>',
  // A parcel riding a canoe: delivery, island style.
  delivery: '<path d="M2 15.5h20c-.8 2.6-3 4-5.5 4h-9C5 19.5 2.8 18.1 2 15.5z"></path><path d="M8 7h8v6H8z"></path><path d="M12 7v6"></path>',
  // Shield with a wave across it.
  safety: '<path d="M12 2.5 19.5 5.5v5.8c0 4.6-3.1 8.3-7.5 9.9-4.4-1.6-7.5-5.3-7.5-9.9V5.5z"></path><path d="M8 12.2c1.3-1.2 2.7-1.2 4 0s2.7 1.2 4 0"></path>',
  // A small building and a rising line.
  business: '<path d="M3 20h18"></path><path d="M5 20V9h7v11"></path><path d="M8 12.5h1M8 15.5h1"></path><path d="m14 15 2.5-3 2 1.5L21 9"></path><path d="M18.5 9H21v2.5"></path>',
  // Two people joined: a service connects someone to someone.
  services: '<circle cx="7" cy="8" r="2.6"></circle><circle cx="17" cy="8" r="2.6"></circle><path d="M2.5 19a4.5 4.5 0 0 1 9 0"></path><path d="M12.5 19a4.5 4.5 0 0 1 9 0"></path><path d="M10 13.5h4"></path>',
  // A house with a key beside it.
  rentals: '<path d="M2.5 11 9 5.5l6.5 5.5"></path><path d="M4.5 9.5V19h9"></path><circle cx="18" cy="13.5" r="2.5"></circle><path d="M18 16v4.5M18 18.5h1.8"></path>',
  // An open book with a route marked on the right page.
  guides: '<path d="M2.5 5.5C5.6 4 8.8 4 12 5.5c3.2-1.5 6.4-1.5 9.5 0v13.5c-3.1-1.5-6.3-1.5-9.5 0-3.2-1.5-6.4-1.5-9.5 0z"></path><path d="M12 5.5V19"></path><path d="M15 14.5l1.5-2.5 1.5 1 1.5-3"></path>',
  // An article card.
  blog: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"></rect><path d="M7.5 8h9M7.5 12h9M7.5 16h5"></path>',
  // A speech bubble carrying a wave.
  support: '<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path><path d="M7.5 10.8c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0"></path>',
  // A person.
  account: '<circle cx="12" cy="8.5" r="3.5"></circle><path d="M5 20a7 7 0 0 1 14 0"></path>',
  arrow: '<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>',
  close: '<path d="M6 6l12 12M18 6 6 18"></path>'
};

/**
 * One icon as an <svg> string.
 *
 * opts.size   pixel size (default 24). 20-28 for UI, 40-64 for category cards.
 * opts.label  give it a name a screen reader announces (role="img"). Without
 *             one the icon is decorative and hidden from assistive tech -
 *             which is right almost everywhere, because the text beside it
 *             already says what it means.
 * opts.className extra class names.
 */
function mwaketeIcon(name, opts) {
  opts = opts || {};
  const inner = MWAKETE_ICON_PATHS[name];
  if (!inner) return '';
  const size = Number(opts.size) > 0 ? Number(opts.size) : 24;
  const cls = 'mw-icon mw-icon--' + name + (opts.className ? ' ' + opts.className : '');
  const a11y = opts.label
    ? ' role="img" aria-label="' + String(opts.label).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';') + '"'
    : ' aria-hidden="true" focusable="false"';
  return '<svg class="' + cls + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + a11y + '>'
    + inner + '</svg>';
}

if (typeof module !== 'undefined') module.exports = { MWAKETE_ICON_PATHS, mwaketeIcon };
