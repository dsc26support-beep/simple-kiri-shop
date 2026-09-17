/**
 * "Does this branch owe a service-worker CACHE bump?"
 *
 * Five suites ask this, and before this file they asked it three different
 * ways, all of them wrong in the same direction - they fired on branches that
 * owed nothing:
 *
 *   verify-footer / verify-categories  demanded the tree always be AHEAD of
 *     main. That fires the instant a branch merges, when tree and main are
 *     equal by definition and there is nothing left to bump.
 *   verify-perf / verify-mycarts       narrowed it to "*.html *.css *.js
 *     differ from main", which is closer but matches tests/*.js - a test file
 *     is not served to anybody and is not in PRECACHE.
 *   verify-panescroll                  fired when ANY file differed, docs and
 *     .gs files included.
 *
 * The honest question is narrower than all three: has a file the service
 * worker actually hands to a browser changed? That is answerable exactly,
 * because sw.js lists them in PRECACHE.
 *
 * Note it is the BUILT files that count. Editing assets/js/home.js owes
 * nothing on its own; the precached file is home.min.js, and it only changes
 * when the build runs. So "changed the source but forgot to build" correctly
 * reads as "nothing served changed" - the served bytes really are identical.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const CACHE_RE = /var CACHE = 'mwakete-v(\d+)';/;

function precachedPaths(swSource) {
  const block = (swSource.match(/var PRECACHE = \[([\s\S]*?)\n\];/) || [])[1] || '';
  return (block.match(/'([^']*)'/g) || [])
    .map((s) => s.slice(1, -1))
    // './' is the site root, which is index.html on any static host.
    .map((p) => (p === './' || p === '/' ? 'index.html' : p))
    .filter(Boolean);
}

/**
 * Returns { owed, mainVer, mineVer, changedPrecached }.
 *
 * owed is true when a precached file differs from main, or when sw.js itself
 * differs by something OTHER than its CACHE line - a changed PRECACHE list or
 * fetch handler is a real change to what gets served. The CACHE line is
 * excluded on purpose: bumping it is the very thing being asked for, and
 * counting it would make the rule demand itself.
 */
function cacheBumpState(repo) {
  const git = (cmd) => execSync('git -C ' + repo + ' ' + cmd, { encoding: 'utf8' });
  const sw = fs.readFileSync(repo + '/sw.js', 'utf8');
  const mainSw = git('show origin/main:sw.js');
  const ver = (t) => Number((t.match(CACHE_RE) || [])[1]);

  const precached = new Set(precachedPaths(sw).concat(precachedPaths(mainSw)));
  const changed = git("diff --name-only origin/main").split('\n').filter(Boolean);
  const changedPrecached = changed.filter((f) => precached.has(f));

  const strip = (t) => t.replace(CACHE_RE, '');
  const swChangedBeyondVersion = changed.indexOf('sw.js') !== -1 && strip(sw) !== strip(mainSw);

  return {
    owed: changedPrecached.length > 0 || swChangedBeyondVersion,
    mainVer: ver(mainSw),
    mineVer: ver(sw),
    changedPrecached: changedPrecached.concat(swChangedBeyondVersion ? ['sw.js'] : [])
  };
}

/** The one assertion, so all five suites phrase the same guarantee. */
function assertCacheBump(repo, ok, label) {
  const s = cacheBumpState(repo);
  const detail = (s.changedPrecached.join(', ') || 'nothing served changed')
    + ' | v' + s.mainVer + ' -> v' + s.mineVer;
  if (s.owed) ok(label + ': CACHE bumped past main, because a precached file changed', s.mineVer > s.mainVer, detail);
  else ok(label + ': no CACHE bump owed - no precached file differs from main', true, detail);
}

module.exports = { cacheBumpState, assertCacheBump, precachedPaths };
