/**
 * Security hardening stage 1 (owner, 16 Nov 2026), in the browser:
 *  - safeUrl / safeDataUrl (helpers.js) let through only web, tel:, mailto:
 *    and in-site links, and only image / PDF document previews;
 *  - the admin drivers list never turns a "javascript:" link or a non-image
 *    "document" from the backend into something that runs;
 *  - the face-check library only runs if it is the exact 1.7.13 file
 *    (Subresource Integrity). With FACE_API_FILE set to a genuine copy of
 *    dist/face-api.js (npm pack @vladmandic/face-api@1.7.13), the genuine
 *    file is checked to load too.
 */
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js';

(async () => {
  const browser = await chromium.launch();

  /* ---------- the helpers ---------- */
  {
    const ctx = await browser.newContext();
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent|facebook/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(BASE + '/help.html', { waitUntil: 'load' });
    const out = await page.evaluate((png) => ({
      pass: ['https://m.me/bong', 'http://example.com/x', 'tel:+68673001234', 'mailto:help@mwakete.com', 'store.html?store=bong', '../invoice.html?d=abc', '#top', '/help.html']
        .map((u) => [u, safeUrl(u)]),
      block: ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)', '//evil.example/x', 'file:///etc/passwd', '', null, undefined].map((u) => [String(u), safeUrl(u)]),
      dataOk: safeDataUrl(png) === png && safeDataUrl('data:application/pdf;base64,JVBERi0=') !== '',
      dataBad: ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', png + '"><img src=x onerror=alert(1)>', 'https://x/y.png']
        .map((u) => safeDataUrl(u))
    }), PNG);
    ok('safeUrl keeps web, tel, mailto and in-site links', out.pass.every(([a, b]) => a === b), J(out.pass));
    ok('safeUrl turns javascript:, data:, vbscript:, file: and //other-site into "#"', out.block.every(([, b]) => b === '#'), J(out.block));
    ok('safeDataUrl keeps image and PDF previews', out.dataOk);
    ok('safeDataUrl refuses HTML, SVG, scripts and anything tacked on', out.dataBad.every((x) => x === ''), J(out.dataBad));
    await ctx.close();
  }

  /* ---------- admin drivers list: hostile data from the backend ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent|facebook/, (r) => r.abort());
    await ctx.route('**/macros/s/**', (route) => {
      let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
      const a = body.action || new URL(route.request().url()).searchParams.get('action');
      let res = { ok: true };
      if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } };
      else if (a === 'adminListDeliveries') res = { ok: true, enabled: true, allIslands: true, areas: [], bankDetailsSet: true,
        counts: { open: 0, active: 1, failed: 0, stuck: 0, driversOnline: 0, driversPending: 1, paymentsToCheck: 0, refundsDue: 0, toDecide: 0 },
        drivers: [{ driverId: 'drv1', name: 'Teeta', phone: '73001234', email: 'd@x.com', vehicle: 'Motorbike', area: 'Tarawa', status: 'pending', delivered: 0, failed: 0,
          docs: { idType: 'Passport', idNumber: 'P1', faceResult: 'passed', faceLabel: 'Face matched', messenger: 'javascript:alert(document.cookie)', hasDocs: true } }],
        jobs: [{ jobId: 'j1', orderId: 'SKS-bong-1', storeName: 'Bong', dropoff: 'Bairiki', driverName: 'Teeta', driverPhone: '73001234', fee: 5, statusLabel: 'On the way',
          location: { link: 'javascript:alert(1)' } }] };
      else if (a === 'adminListPayouts') res = { ok: true, payouts: [] };
      else if (a === 'adminDriverDocs') res = { ok: true, id: { label: 'ID', dataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', mimeType: 'image/png' },
        selfie: { label: 'Face photo', dataUrl: PNG, mimeType: 'image/png' },
        contract: [{ label: 'Signed page', dataUrl: 'javascript:alert(1)', mimeType: 'application/pdf' }] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
    await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    await page.waitForSelector('#dlv-drivers [data-driver-docs]', { timeout: 8000 }).catch(() => {});
    const hrefs = await page.$$eval('#dlv-drivers a, #dlv-jobs a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
    const msg = hrefs.find(([t]) => /Messenger/.test(t));
    const loc = hrefs.find(([t]) => /Live location/.test(t));
    ok('a driver\'s "javascript:" Messenger link becomes "#"', !!msg && msg[1] === '#', J(hrefs));
    ok('a job\'s "javascript:" live-location link becomes "#"', !!loc && loc[1] === '#', J(hrefs));
    ok('no link on the drivers list starts with javascript:', hrefs.length > 0 && !hrefs.some(([, h]) => /^\s*javascript:/i.test(h || '')), J(hrefs));
    await page.click('#dlv-drivers [data-driver-docs]');
    await page.waitForSelector('#dlv-docs-drv1:not([hidden])', { timeout: 5000 }).catch(() => {});
    const docs = await page.evaluate(() => {
      const box = document.getElementById('dlv-docs-drv1');
      return { imgs: Array.from(box.querySelectorAll('img')).map((i) => i.getAttribute('src').slice(0, 22)),
        links: Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href')), text: box.textContent };
    });
    ok('documents: the real image is shown', docs.imgs.length === 1 && docs.imgs[0] === 'data:image/png;base64,', J(docs));
    ok('documents: an HTML "document" and a javascript: PDF are shown as missing, not opened', /ID - file missing/.test(docs.text) && /Signed page - file missing/.test(docs.text) && docs.links.length === 0, J(docs));
    await page.waitForTimeout(300);
    ok('nothing ran (no alert) and no page errors', dialogs.length === 0 && errors.length === 0, J([dialogs, errors]));
    await ctx.close();
  }

  /* ---------- face check library: Subresource Integrity ---------- */
  const src = fs.readFileSync(require('path').join(__dirname, '../assets/js/driver-face.js'), 'utf8');
  ok('driver-face.js sets a sha384 integrity hash on the face-api script', /LIB_INTEGRITY = 'sha384-[A-Za-z0-9+/]{64}'/.test(src) && /s\.integrity = LIB_INTEGRITY/.test(src));
  const genuine = process.env.FACE_API_FILE && fs.existsSync(process.env.FACE_API_FILE) ? fs.readFileSync(process.env.FACE_API_FILE) : null;
  for (const [label, body] of [['a changed copy of the library', 'window.faceapi = { pwned: true };'], ...(genuine ? [['the genuine 1.7.13 file', genuine]] : [])]) {
    const ctx = await browser.newContext({ permissions: [] });
    await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent|facebook/, (r) => r.abort());
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    let served = 0;
    await ctx.route(LIB, (r) => { served++; r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body }); });
    await ctx.route(/face-api@1\.7\.13\/model/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(BASE + '/driver.html', { waitUntil: 'load' });
    const res = await page.evaluate(async () => {
      if (typeof DriverFace === 'undefined') return { missing: true };
      const mount = document.createElement('div'); document.body.appendChild(mount);
      const r = await Promise.race([DriverFace.run({ mount, idImageUrl: '' }), new Promise((x) => setTimeout(() => x({ result: 'timeout' }), 15000))]);
      return { result: r.result, faceapi: typeof window.faceapi, pwned: !!(window.faceapi && window.faceapi.pwned) };
    });
    if (genuine) {
      if (label.indexOf('genuine') !== -1) ok('the genuine library passes the integrity check and loads', served === 1 && res.faceapi === 'object' && !res.pwned, J(res));
      else ok('a changed library is refused: it never runs, the check falls back to "unsupported"', served === 1 && !res.pwned && res.faceapi === 'undefined' && res.result === 'unsupported', J(res));
    } else {
      ok('a changed library is refused: it never runs, the check falls back to "unsupported"', served === 1 && !res.pwned && res.faceapi === 'undefined' && res.result === 'unsupported', J(res));
    }
    await ctx.close();
  }
  if (!genuine) console.log('(FACE_API_FILE not set: the genuine-file check was skipped)');

  await browser.close();
  R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
