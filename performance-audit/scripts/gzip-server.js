// Static server that gzips text assets, the way GitHub Pages does. The plain
// python http.server used for the first pass does NOT compress, which
// overstated CSS/JS transfer by ~4x and made every throttled run pessimistic.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = '/home/user/simple-kiri-shop';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const COMPRESS = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest']);

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? '/index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  let body = fs.readFileSync(file);
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
  if (COMPRESS.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  // GitHub Pages serves assets with a 10-minute max-age.
  headers['Cache-Control'] = 'max-age=600';
  res.writeHead(200, headers);
  res.end(body);
}).listen(8100, '127.0.0.1', () => console.log('gzip server on 8100'));
