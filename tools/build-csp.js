#!/usr/bin/env node
/**
 * Writes the Content-Security-Policy <meta> tag onto every page of the site
 * (security audit 2026-11, finding 1 - "No CSP on any of 45 pages").
 *
 * WHY A <meta> TAG
 * ----------------
 * GitHub Pages cannot send HTTP response headers, so the policy travels in a
 *   <meta http-equiv="Content-Security-Policy" content="...">
 * placed right after <meta charset> (as early as possible, before any script
 * or resource the policy must govern). Two header-only protections - HSTS and
 * frame-ancestors (anti-clickjacking) - CANNOT be expressed in a meta tag and
 * are deliberately NOT faked here; they need the Cloudflare proxy (audit
 * "extras"). See docs/security-audit-2026-11.md, Stage 2.
 *
 * HOW THE INLINE SCRIPTS ARE ALLOWED (strict, no 'unsafe-inline')
 * --------------------------------------------------------------
 * script-src lists 'self', the three third-party script hosts, and a SHA-256
 * hash for every inline <script> block on the site. 'unsafe-inline' is NOT
 * used for scripts, so an injected <script> or on*= attribute cannot run -
 * that is the whole safety net the audit asked for. Nonces are not an option
 * on static hosting (no server to stamp a fresh one per response), so hashes
 * it is. Inline on*= handlers were removed from the pages (driver-contract,
 * offline) so no handler depends on 'unsafe-inline'.
 *
 * The hash set is the UNION across all pages, so one identical policy string
 * ships on every page. A page carrying a hash for a block it does not contain
 * is harmless; keeping the string identical keeps it auditable and lets the
 * service worker cache it like any other shell byte.
 *
 * style-src keeps 'unsafe-inline' on purpose: a handful of inline style="..."
 * attributes and two <style> blocks remain, and inline CSS cannot execute
 * script, so this is not an XSS vector. Removing them is future hardening, not
 * Stage 2. (Documented in the audit.)
 *
 *   node tools/build-csp.js          write / refresh the <meta> on every page
 *   node tools/build-csp.js --check  exit 1 if any page's <meta> is stale
 *
 * Run LAST in the build chain: it hashes the final bytes of the generated
 * inline blocks (e.g. the early-fetch block from build-early.js), so those
 * must already be written when this runs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

// Directories never served from mwakete.com (GitHub Pages serves the repo root
// minus these): the Sheets add-on runs inside Google's HtmlService sandbox and
// has its own CSP, the Android project is not web content, and tooling/test/
// build folders never ship.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'sheets-addon', 'android', 'tests', 'tools', 'performance-audit', '.handoff', '.github']);

// ----- the policy, minus the script-src hashes (filled in below) -------------
// Host notes (verified against the code, Nov 2026):
//   script  accounts.google.com  Google Identity (google-signin.js)
//           connect.facebook.net Facebook SDK (facebook-signin.js)
//           cdn.jsdelivr.net     face-api (driver-face.js, SRI-pinned) + ZXING (pos-camera.js)
//   connect script.google.com + script.googleusercontent.com  Apps Script backend
//                                (the /exec call 302-redirects to the usercontent host)
//           accounts.google.com  GSI token exchange
//           cdn.jsdelivr.net     face-api model weights (fetched by the library)
//           *.facebook.com / connect.facebook.net  Facebook login
//   img     res.cloudinary.com   product / logo photos
//           *.googleusercontent.com, drive.google.com  Google avatars & Drive-hosted images
//   frame   accounts.google.com (GSI iframe), *.facebook.com (FB login iframe + XD arbiter)
// media-src/font-src/etc. fall back to default-src 'self'. getUserMedia (camera,
// face check / POS scanner) is governed by Permissions-Policy, not CSP.
function directives(hashList) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // www.gstatic.com: the Firebase Cloud Messaging SDK, loaded only when the
    // owner has configured Web Push (APP_CONFIG.PUSH_CONFIG) and a shopper opts
    // in (push-register.js / firebase-messaging-sw.js). Inert otherwise.
    "script-src 'self' https://accounts.google.com https://connect.facebook.net https://cdn.jsdelivr.net https://www.gstatic.com " + hashList.join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://res.cloudinary.com https://*.googleusercontent.com https://drive.google.com",
    "font-src 'self' data:",
    // *.googleapis.com / firebaseinstallations: FCM token registration during
    // Web Push opt-in (same owner-gated path as the gstatic script host).
    "connect-src 'self' https://script.google.com https://script.googleusercontent.com https://accounts.google.com https://cdn.jsdelivr.net https://connect.facebook.net https://graph.facebook.com https://www.facebook.com https://fcmregistrations.googleapis.com https://firebaseinstallations.googleapis.com",
    "frame-src https://accounts.google.com https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join('; ');
}

// Inline <script> blocks (no src attribute), captured exactly as the browser
// hashes them: the raw text between the tags, tags excluded.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function listPages() {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(ROOT, full);
      if (fs.statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (name.endsWith('.html')) {
        out.push(rel);
      }
    }
  })(ROOT);
  return out.sort();
}

function inlineHashes(html) {
  const hashes = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;           // external script: covered by 'self'/host
    const digest = crypto.createHash('sha256').update(m[2], 'utf8').digest('base64');
    hashes.push("'sha256-" + digest + "'");
  }
  return hashes;
}

function metaBlock(policy) {
  return [
    '  <!-- csp -->',
    '  <!-- GENERATED by tools/build-csp.js - do not edit here. Content-Security-Policy',
    '       for every served page; strict script-src (hashes, no \'unsafe-inline\'). HSTS and',
    '       frame-ancestors are header-only and need the Cloudflare proxy - see the audit. -->',
    '  <meta http-equiv="Content-Security-Policy" content="' + policy + '">',
    '  <!-- /csp -->'
  ].join('\n');
}

function withMeta(html, block) {
  const re = /[ \t]*<!-- csp -->[\s\S]*?<!-- \/csp -->/;
  if (re.test(html)) return html.replace(re, block);
  // First insert: place immediately after the <meta charset ...> line.
  const charset = html.match(/([ \t]*<meta\s+charset=[^>]*>)/i);
  if (charset) return html.replace(charset[1], charset[1] + '\n' + block);
  // Fallback: just after <head>.
  return html.replace(/(<head[^>]*>)/i, '$1\n' + block);
}

const pages = listPages();

// Pass 1: union of inline-script hashes across every served page (sorted so the
// output is deterministic - --check compares byte for byte).
const union = new Set();
for (const rel of pages) {
  for (const h of inlineHashes(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) union.add(h);
}
const policy = directives([...union].sort());
const block = metaBlock(policy);

// Pass 2: write (or check) the <meta> on every page.
let changed = 0, stale = [];
for (const rel of pages) {
  const file = path.join(ROOT, rel);
  const html = fs.readFileSync(file, 'utf8');
  const built = withMeta(html, block);
  if (built === html) continue;
  if (CHECK) stale.push(rel);
  else { fs.writeFileSync(file, built); changed++; console.log('  csp -> ' + rel); }
}

if (CHECK) {
  if (stale.length) {
    console.error('\nCSP <meta> is missing or out of date on:\n');
    for (const s of stale) console.error('  ' + s);
    console.error('\nRun `npm run build` and commit the result.\n');
    process.exit(1);
  }
  console.log('CSP <meta> matches on all ' + pages.length + ' pages (' + union.size + ' inline-script hashes).');
} else {
  console.log('\nCSP: ' + pages.length + ' pages, ' + union.size + ' inline-script hashes, ' + changed + ' page(s) updated.');
}
