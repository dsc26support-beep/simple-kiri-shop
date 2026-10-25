// Drive with Mwakete application (owner request, Oct 2026), browser side with
// the backend mocked, a fake camera, and face-api.js stood in for by a script
// that reports a head looking straight, then turned left, then right.
// Checks: Messenger + email under phone with the approval note, ONE ID with
// its photo, the green-ring face check, the agreement signed in the app (and
// on paper), the payload sent, and the 2-page agreement.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { testPngBase64 } = require('./lib/gas-harness.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const CUST = { customerId: 'c1', name: 'Dan Driver', email: 'dan@x.com', phone: '73000009', emailVerified: true };

// Landmarks: eye corners 36/45 and nose tip 30. The fake turns the head over time.
const FAKE_FACEAPI = `
  (function () {
    var t0 = Date.now();
    function pts(noseX) { var p = []; for (var i = 0; i < 68; i++) p.push({ x: 100, y: 100 }); p[36] = { x: 80, y: 100 }; p[45] = { x: 120, y: 100 }; p[30] = { x: noseX, y: 120 }; return p; }
    function current() { var s = (Date.now() - t0) / 1000; var nose = s < 0.8 ? 100 : s < 1.6 ? 100 + 16 : 100 - 16; return { landmarks: { positions: pts(nose) }, descriptor: [0, 0] }; }
    function chain(v) { var p = Promise.resolve(v); return { then: p.then.bind(p), withFaceLandmarks: function () { return chain(v); }, withFaceDescriptor: function () { return chain(v); } }; }
    var net = { loadFromUri: function () { return Promise.resolve(); } };
    window.faceapi = { nets: { tinyFaceDetector: net, faceLandmark68Net: net, faceRecognitionNet: net },
      TinyFaceDetectorOptions: function () {}, fetchImage: function () { return Promise.resolve({}); },
      detectSingleFace: function () { return chain(current()); }, euclideanDistance: function () { return 0.31; } };
  })();`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    const posted = [];
    await ctx.addInitScript((c) => { localStorage.setItem('skiri_cookie_consent', 'true'); localStorage.setItem('skiri_customer_token', 't'); localStorage.setItem('skiri_customer_profile', JSON.stringify(c)); }, CUST);
    await ctx.route('**/@vladmandic/face-api@*/dist/face-api.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_FACEAPI }));
    await ctx.route('**/macros/s/**', (r) => {
      let b = {}; try { b = r.request().postDataJSON() || {}; } catch (e) {}
      if (b.action) posted.push(b);
      const res = b.action === 'getDriverHome'
        ? { ok: true, enabled: true, driver: posted.some((p) => p.action === 'driverApply') ? { status: 'pending' } : null, vehicles: { motorbike: 'Motorbike' }, areas: ['South Tarawa'],
          idTypes: { kpf: 'KPF ID', national: 'National ID', passport: 'Passport', licence: "Driver's licence" }, contractVersion: '2026-10-v1' }
        : { ok: true, status: 'pending' };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/driver.html', { waitUntil: 'load' });
    await page.waitForSelector('#drv-apply:not([hidden])');
    return { ctx, page, posted, errors };
  };
  const idFile = { name: 'id.png', mimeType: 'image/png', buffer: Buffer.from(testPngBase64(200, 140), 'base64') };

  /* ---------- digital signing, face check passes ---------- */
  {
    const { ctx, page, posted, errors } = await open();
    const order = await page.evaluate(() => ['drv-phone', 'drv-messenger', 'drv-email'].map((id) => document.getElementById(id).getBoundingClientRect().top));
    ok('Messenger and email come right under phone', order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
    ok('...with the note that approval comes on Messenger', /contact you on\s+Messenger about your approval/i.test(await page.textContent('#drv-apply')));
    ok('email is filled from the account', (await page.inputValue('#drv-email')) === 'dan@x.com');
    ok("ID choices: KPF ID, National ID, Passport, Driver's licence", (await page.$$eval('input[name="drv-idtype"]', (r) => r.map((x) => x.value).join())) === 'kpf,national,passport,licence');
    // Owner request (Oct 2026): ID photo offers camera AND upload (no capture
    // attribute); the backup face photo stays camera-only.
    ok('ID photo: phone offers Camera and Upload (no camera-only lock)', await page.$eval('#drv-idphoto', (i) => !i.hasAttribute('capture') && i.accept === 'image/*'));
    ok('...the backup face photo stays camera-only', (await page.getAttribute('#drv-selfie', 'capture')) === 'user');
    const intro = await page.evaluate(() => { const p = document.querySelector('#drv-apply > p.helper-text'); const a = p.querySelector('a');
      return { text: p.textContent.replace(/\s+/g, ' ').trim(), link: a && a.textContent.trim(), href: a && a.getAttribute('href') }; });
    ok('intro is short: own fee, then "How this works" (capital H) to the driver terms',
      intro.text === 'Independent drivers deliver orders for Mwakete sellers on their own island. You set your own fee. How this works' && intro.link === 'How this works' && intro.href === 'terms.html#drivers', JSON.stringify(intro));
    ok('face check text no longer says it matches your ID / runs on your phone', !/We then match|runs on your phone/.test(await page.textContent('#drv-apply')));
    // Messenger "Help?" (owner request, Oct 2026): inside the box at its right
    // edge; pressing it swaps "Mwakete will contact you..." for the steps, and
    // pressing again swaps back.
    ok('Messenger: placeholder e.g. https://m.me/username, "Help?" inside the box at the far right', await page.evaluate(() => {
      const i = document.getElementById('drv-messenger'), b = i.parentNode.querySelector('.fbh-btn'), r = i.getBoundingClientRect(), q = b.getBoundingClientRect();
      return i.placeholder === 'e.g. https://m.me/username' && b.textContent.trim() === 'Help?' && q.left > r.left + r.width / 2 && q.right <= r.right && r.right - q.right < 12 && q.top >= r.top && q.bottom <= r.bottom; }));
    const swap = () => page.evaluate(() => { const v = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
      const steps = document.querySelector('#drv-messenger-steps');
      return { note: v(document.getElementById('drv-messenger-note')), steps: v(steps), text: steps ? steps.textContent : '' }; });
    const s0 = await swap();
    await page.click('#drv-apply .fbh-btn');
    const s1 = await swap();
    await page.click('#drv-apply .fbh-btn');
    const s2 = await swap();
    ok('...Help? hides "Mwakete will contact you" and shows the steps in its place', s0.note && !s0.steps && !s1.note && s1.steps
      && s1.text === 'Open Messenger > Menu > Settings > Username, then enter m.me/your-username', JSON.stringify({ s0, s1 }));
    ok('...pressing Help? again brings the note back and hides the steps', s2.note && !s2.steps, JSON.stringify(s2));
    await page.fill('#drv-messenger', 'dan.driver');
    await page.click('#drv-face-start');
    ok('the face check asks for the ID photo first', /photo of your ID first/.test(await page.textContent('#drv-face-result')));
    await page.check('input[name="drv-idtype"][value="national"]');
    await page.fill('#drv-idnumber', 'N1234567');
    await page.setInputFiles('#drv-idphoto', idFile);
    await page.waitForSelector('#drv-idpreview:not([hidden])');
    await page.click('#drv-face-start');
    await page.waitForSelector('.fc-ring');
    ok('the face check shows the camera inside a ring of marks', (await page.$$('.fc-tick')).length === 36 && !!(await page.$('.fc-video')));
    await page.waitForFunction(() => document.querySelectorAll('.fc-tick.is-on').length > 0, null, { timeout: 8000 });
    ok('...marks turn green as the head turns', true);
    await page.waitForFunction(() => /passed/i.test(document.getElementById('drv-face-result').textContent), null, { timeout: 15000 });
    ok('when the ring is full and the face matches: "Face check passed"', /Face check passed/.test(await page.textContent('#drv-face-result')));
    ok('...and the camera is closed', !(await page.$('.fc-video')));

    await page.click('#drv-apply-form button[type="submit"]');
    ok('sending without signing is stopped', /Tick that you have read/.test(await page.textContent('#drv-apply-error')));
    await page.check('#drv-agree');
    await page.fill('#drv-signname', 'Dan Driver');
    const box = await page.locator('#drv-sig').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 70, { steps: 8 }); await page.mouse.move(box.x + 200, box.y + 30, { steps: 8 }); await page.mouse.up();
    await page.click('#drv-apply-form button[type="submit"]');
    await page.waitForSelector('#drv-wait:not([hidden])');
    const sent = posted.find((p) => p.action === 'driverApply') || {};
    ok('the application carries Messenger, email, ID type and number', sent.messenger === 'dan.driver' && sent.email === 'dan@x.com' && sent.idType === 'national' && sent.idNumber === 'N1234567', JSON.stringify({ m: sent.messenger, e: sent.email, t: sent.idType }));
    ok('...the ID photo and face photo as images', /^\/9j\/|^iVBOR/.test(sent.idPhotoBase64 || '') && /^\/9j\//.test(sent.selfieBase64 || ''));
    ok('...the face result', sent.faceResult === 'passed' && sent.faceScore === 0.31);
    ok('...and the agreement signed in the app', sent.contract && sent.contract.method === 'digital' && sent.contract.version === '2026-10-v1' && sent.contract.signedName === 'Dan Driver' && /^iVBOR/.test(sent.contract.signatureBase64 || ''));
    ok('afterwards: waiting, and told they will hear on Messenger', /Messenger about your approval/.test(await page.textContent('#drv-wait-text')));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ---------- paper signing ---------- */
  {
    const { ctx, page, posted } = await open();
    await page.fill('#drv-messenger', 'dan.driver');
    await page.check('input[name="drv-idtype"][value="passport"]');
    await page.fill('#drv-idnumber', 'KR0001234');
    await page.setInputFiles('#drv-idphoto', idFile);
    await page.waitForSelector('#drv-idpreview:not([hidden])');
    await page.click('#drv-face-start');
    await page.waitForFunction(() => /passed/i.test(document.getElementById('drv-face-result').textContent), null, { timeout: 15000 });
    await page.check('input[name="drv-sign"][value="physical"]');
    ok('choosing paper shows the print link and the page upload', await page.isVisible('#drv-pages') && !(await page.isVisible('#drv-sig')));
    await page.setInputFiles('#drv-pages', [idFile, Object.assign({}, idFile, { name: 'p2.png' })]);
    await page.click('#drv-apply-form button[type="submit"]');
    await page.waitForSelector('#drv-wait:not([hidden])');
    const sent = posted.find((p) => p.action === 'driverApply') || {};
    ok('paper: both page photos are sent', sent.contract && sent.contract.method === 'physical' && sent.contract.pagesBase64.length === 2, JSON.stringify(sent.contract && { m: sent.contract.method, n: (sent.contract.pagesBase64 || []).length }));
    await ctx.close();
  }

  /* ---------- the agreement prints on two pages ---------- */
  {
    const page = await browser.newPage();
    await page.goto(BASE + '/driver-contract.html', { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok('the Driver Agreement prints on exactly 2 pages', pages === 2, String(pages));
    const text = await page.textContent('.contract');
    ok('...between MainKT Enterprise (Mwakete) and the driver, as an independent driver who sets their own fee',
      /MainKT Enterprise, trading as Mwakete/.test(text) && /independent driver/.test(text) && /You set your own fee/.test(text));
    ok('...covering ID, face check, privacy and the 90-day deletion', /KPF ID, National ID, passport or driver\u2019s licence/.test(text) && /face check/.test(text) && /deleted 90 days/.test(text));
    await page.close();
  }

  await browser.close();
  let failed = 0;
  for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
