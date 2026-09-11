#!/usr/bin/env node
/**
 * Strips comments and whitespace from the served CSS and JS.
 *
 * WHY THIS EXISTS
 * ---------------
 * 38% of styles.css and 47% of helpers.js is comments. Gzip does not hide
 * them: measured on the tree, comments cost 69.7 KB gzipped, and about 29 KB
 * of that lands on the homepage alone - roughly 44% of its weight, downloaded
 * by every first-time visitor, doing nothing at runtime. On the 400 kbps
 * connections this site is built for, that is about 0.6 s of the first paint.
 *
 * The comments are worth keeping in source. So the SOURCE files keep every one
 * of them, and the pages load generated `.min` copies instead.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No compression, no mangling, no code transformation of any kind:
 *
 *   terser     compress: false, mangle: false
 *   clean-css  level 1 (value-preserving only; level 2 merges and reorders
 *              rules, which can change the cascade, and is NOT used)
 *
 * The entire win here is comments and whitespace. Renaming variables or
 * rewriting expressions would add real risk - these modules define globals that
 * other modules reach for by name (`Cart`, `Api`, `Helpers`) - to buy a few
 * hundred bytes. Not a trade worth making. If someone later wants the extra
 * bytes, turn the options on ONE at a time and run the full suite between each.
 *
 * sw.js IS EXCLUDED ON PURPOSE. A broken service worker is the one failure on
 * this site that keeps hurting after it is fixed - it can serve stale content
 * to returning visitors indefinitely. It costs 2 KB gzipped to leave alone.
 *
 * USAGE
 *   npm run build          rebuild every .min file
 *   npm run build:check    verify the committed .min files match source; exits
 *                          1 if any is stale. This is what the guard test runs.
 */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

// Everything a page loads, except sw.js - see the header.
const JS_DIR = path.join(ROOT, 'assets', 'js');
const CSS_FILES = ['assets/css/styles.css', 'assets/css/owner.css'];
const EXCLUDE = new Set(['sw.js']);

function minName(rel) {
  const ext = path.extname(rel);
  return rel.slice(0, -ext.length) + '.min' + ext;
}

async function buildJs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = await minify(src, {
    compress: false,
    mangle: false,
    format: { comments: false },
    sourceMap: false
  });
  if (typeof out.code !== 'string') throw new Error('terser returned no code for ' + rel);
  return out.code;
}

function buildCss(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // level 1 is clean-css's value-preserving level: whitespace, comments, and
  // rewrites that cannot change what a rule means (`0.5em` -> `.5em`, hex
  // shortening). Level 0 does NOT strip comments - it left 136 of them in place
  // and captured 944 of the 17,634 gzipped bytes available on styles.css.
  // Level 2 merges and reorders rules, which CAN change cascade behaviour when
  // two selectors have equal specificity. Not used, deliberately.
  const out = new CleanCSS({ level: { 1: { specialComments: 0 } } }).minify(src);
  if (out.errors && out.errors.length) throw new Error(rel + ': ' + out.errors.join('; '));
  return out.styles;
}

(async () => {
  const jsFiles = fs.readdirSync(JS_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.min.js') && !EXCLUDE.has(f))
    .map((f) => path.join('assets', 'js', f));
  const targets = [...jsFiles.map((f) => [f, 'js']), ...CSS_FILES.map((f) => [f, 'css'])];

  const stale = [];
  let rawIn = 0, rawOut = 0;

  for (const [rel, kind] of targets) {
    const built = kind === 'js' ? await buildJs(rel) : buildCss(rel);
    const dest = minName(rel);
    const destPath = path.join(ROOT, dest);
    rawIn += fs.statSync(path.join(ROOT, rel)).size;
    rawOut += Buffer.byteLength(built);

    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : null;
    if (existing === built) continue;

    if (CHECK) {
      stale.push(dest + (existing === null ? ' (missing)' : ' (out of date)'));
    } else {
      fs.writeFileSync(destPath, built);
      console.log('  built ' + dest);
    }
  }

  if (CHECK) {
    if (stale.length) {
      console.error('\nThese built files do not match their source:\n');
      for (const s of stale) console.error('  ' + s);
      console.error('\nRun `npm run build` and commit the result.\n');
      process.exit(1);
    }
    console.log(targets.length + ' built files match their source.');
    return;
  }

  console.log('\n' + targets.length + ' files: ' + rawIn + ' -> ' + rawOut + ' bytes raw ('
    + Math.round((1 - rawOut / rawIn) * 100) + '% smaller before gzip)');
})().catch((err) => { console.error(err); process.exit(1); });
