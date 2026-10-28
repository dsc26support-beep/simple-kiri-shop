// Mwakete POS - scan barcodes with the phone or laptop camera. Oct 2026.
// Uses the browser's own BarcodeDetector where it exists (Chrome on Android),
// otherwise ZXing (free, open source, MIT) loaded from jsDelivr only when the
// camera is opened. USB and Bluetooth scanners need none of this: they type
// the code like a keyboard (pos-app.js listens for that).
// Formats: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39. The code is passed
// on as TEXT, so leading zeros are kept.
const PosCamera = (function () {
  const ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];
  let zxingReady = null;

  function loadZxing() {
    if (window.ZXing) return Promise.resolve();
    if (!zxingReady) {
      zxingReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ZXING; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => resolve(); s.onerror = () => { zxingReady = null; reject(new Error('scanner')); };
        document.head.appendChild(s);
      });
    }
    return zxingReady;
  }

  async function nativeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const use = FORMATS.filter((f) => supported.indexOf(f) !== -1);
      return use.length ? new window.BarcodeDetector({ formats: use }) : null;
    } catch (e) { return null; }
  }

  /** Opens the camera; calls onCode(text) once with the first code read. */
  function open(onCode) {
    const wrap = document.createElement('div');
    wrap.className = 'pos-dialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Scan with the camera');
    wrap.innerHTML = `<div class="pos-dialog-box pos-camera"><h2>Scan with the camera</h2>
      <video playsinline muted autoplay></video><p class="pos-camera-hint" role="status">Starting the camera…</p>
      <div class="pos-dialog-actions"><button type="button" class="btn" data-stop>Close</button></div></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video');
    const hint = wrap.querySelector('.pos-camera-hint');
    let stream = null, stopped = false, zreader = null;
    const stop = () => {
      stopped = true;
      if (zreader) { try { zreader.reset(); } catch (e) { /* closed */ } }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
    };
    wrap.querySelector('[data-stop]').addEventListener('click', stop);
    const found = (text) => {
      if (stopped || !text) return;
      if (navigator.vibrate) navigator.vibrate(60);
      stop();
      onCode(String(text));
    };

    (async () => {
      const detector = await nativeDetector();
      if (!detector) {
        try { await loadZxing(); } catch (e) {
          hint.textContent = 'The camera scanner could not load (it needs a connection the first time on this device). Type the code or use a barcode scanner.';
          return;
        }
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        hint.textContent = e && e.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow the camera for this site in the browser settings (the lock icon by the address), then try again.'
          : 'No camera could be opened on this device. Type the code or use a barcode scanner.';
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      hint.textContent = 'Hold the barcode inside the picture.';
      if (detector) {
        const loop = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) { found(codes[0].rawValue); return; }
          } catch (e) { /* keep trying */ }
          setTimeout(loop, 160);
        };
        loop();
      } else {
        const hints = new Map();
        const F = window.ZXing.BarcodeFormat;
        hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39]);
        zreader = new window.ZXing.BrowserMultiFormatReader(hints);
        zreader.decodeFromVideoElementContinuously(video, (result) => { if (result) found(result.getText()); });
      }
    })();
  }

  return { open };
})();
