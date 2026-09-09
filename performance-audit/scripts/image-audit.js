// Image audit: the repo's own assets, plus how remote photos are requested.
const fs = require('fs');
const REPO = '/home/user/simple-kiri-shop/';
const inv = JSON.parse(fs.readFileSync(REPO + 'performance-audit/data/inventory.json', 'utf8'));

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return null;
}
function svgSize(txt) {
  const vb = txt.match(/viewBox="([\d.\s-]+)"/);
  if (vb) { const p = vb[1].trim().split(/\s+/); return { w: +p[2], h: +p[3] }; }
  const w = txt.match(/width="(\d+)/), h = txt.match(/height="(\d+)/);
  return w && h ? { w: +w[1], h: +h[1] } : null;
}

const imgs = inv.files.filter((f) => f.kind === 'Image').map((f) => {
  const buf = fs.readFileSync(REPO + f.path);
  const dim = f.path.endsWith('.svg') ? svgSize(buf.toString('utf8')) : pngSize(buf);
  return { path: f.path, bytes: f.bytes, format: (f.path.match(/\.(\w+)$/) || [, '?'])[1],
    w: dim ? dim.w : null, h: dim ? dim.h : null };
}).sort((a, b) => b.bytes - a.bytes);

console.log('=== BUNDLED IMAGE ASSETS (in the repo) ===');
console.log('file'.padEnd(42) + 'format'.padEnd(7) + 'bytes'.padStart(9) + '  dimensions');
let total = 0;
for (const i of imgs) {
  total += i.bytes;
  console.log(i.path.padEnd(42) + i.format.padEnd(7) + String(i.bytes).padStart(9) +
    '  ' + (i.w ? `${i.w}x${i.h}` : 'n/a'));
}
console.log(`TOTAL bundled images: ${(total / 1024).toFixed(1)} KB across ${imgs.length} files`);

// Which of them are actually requested on a page load?
const referenced = new Set();
for (const p of inv.pages) p.imgs.forEach((s) => referenced.add(s.replace(/^(\.\.\/)+/, '')));
const cssTxt = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
for (const m of cssTxt.matchAll(/url\(['"]?([^'")]+)/g)) referenced.add(m[1].replace(/^(\.\.\/)+/, ''));
const manifest = JSON.parse(fs.readFileSync(REPO + 'manifest.json', 'utf8'));
(manifest.icons || []).forEach((i) => referenced.add(i.src.replace(/^\.\//, '')));

console.log('\n=== ARE THEY ON THE CRITICAL PATH? ===');
for (const i of imgs) {
  const inHtml = referenced.has(i.path);
  const inManifest = (manifest.icons || []).some((x) => x.src.replace(/^\.\//, '') === i.path);
  console.log(i.path.padEnd(42) + (inHtml ? 'referenced' : 'not in HTML/CSS') +
    (inManifest ? '  (PWA manifest icon - fetched on install, not on load)' : ''));
}

// The remote-image pipeline.
const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const optimizer = (helpers.match(/function optimizedImageUrl[\s\S]*?\n}/) || [''])[0];
const widths = (helpers.match(/const IMG_W = \{[^}]*\}/) || [''])[0];
console.log('\n=== REMOTE IMAGE PIPELINE ===');
console.log(widths || '(IMG_W not found)');
console.log('\nCloudinary transform inserted:',
  /f_auto/.test(optimizer) ? 'f_auto (format negotiation, gives WebP/AVIF where supported)' : 'NONE');
console.log('Quality:', /q_auto/.test(optimizer) ? 'q_auto' : 'not set');
console.log('Width cap:', /w_\$\{|w_'\s*\+|c_fill|c_limit/.test(optimizer) ? 'yes, per IMG_W preset' : 'not set');
console.log('Google Drive photos:', /googleusercontent/.test(optimizer) ? 'resized via =w<N> suffix' : 'not handled');
console.log('\nSrcset / <picture> used anywhere:',
  /srcset|<picture/.test(fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8') +
    inv.pages.map((p) => fs.readFileSync(REPO + p.page, 'utf8')).join('')) ? 'YES' : 'NO');

let lazy = 0, eager = 0;
for (const f of inv.files.filter((x) => x.kind === 'JS')) {
  const src = fs.readFileSync(REPO + f.path, 'utf8');
  lazy += (src.match(/loading="lazy"/g) || []).length;
  eager += (src.match(/loading="eager"/g) || []).length;
}
console.log(`<img> emitted by JS with loading="lazy": ${lazy}   eager: ${eager}`);

fs.writeFileSync(REPO + 'performance-audit/data/images.json', JSON.stringify({ imgs, totalBytes: total }, null, 2));
