/**
 * Face check for Drive with Mwakete (owner request, Oct 2026).
 *
 * The driver looks at the camera, then turns their head left and right. The
 * marks around the oval turn green as they turn; when the ring is full the
 * head-turn ("is this a real person, not a photo") check is done. A photo
 * taken while they looked straight ahead is then compared with the face on
 * their ID photo.
 *
 * Everything runs ON THE PHONE with face-api.js (free, open source, loaded from
 * jsDelivr only when the check starts). No face is sent to any other company.
 * Because a phone-side check can be fooled, the result is advice only: the
 * photo and the ID still go to a Mwakete admin, who approves the driver
 * (owner decision: passing approves the face step, not the driver).
 *
 * DriverFace.run({ mount, idImageUrl }) resolves with
 *   { result: 'passed'|'not_matched'|'liveness_failed'|'unsupported', score, selfie (Blob|null), note }
 * or rejects with 'cancelled'.
 */
const DriverFace = (() => {
  const LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js';
  const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model';
  const TICKS = 36;
  const TURN = 0.28;            // how far the head must turn (nose offset / eye distance)
  const MATCH = 0.55;           // face-api distance below which two faces are the same person
  const ATTEMPT_MS = 30000;
  const MAX_ATTEMPTS = 3;
  let ready = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.faceapi) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => resolve(); s.onerror = () => reject(new Error('script'));
      document.head.appendChild(s);
    });
  }

  function load() {
    if (!ready) {
      ready = loadScript(LIB).then(() => Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS)
      ])).catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  const detector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });

  /** Head turn from the landmarks: < 0 one way, > 0 the other; ~0 looking straight. */
  function yawOf(landmarks) {
    const p = landmarks.positions;
    const leftEye = p[36], rightEye = p[45], nose = p[30];
    const midX = (leftEye.x + rightEye.x) / 2;
    const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 1;
    return (nose.x - midX) / eyeDist;
  }

  async function idDescriptor(url) {
    const img = await faceapi.fetchImage(url);
    const d = await faceapi.detectSingleFace(img, detector()).withFaceLandmarks().withFaceDescriptor();
    return d ? d.descriptor : null;
  }

  function ringSvg() {
    let marks = '';
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const x1 = 50 + Math.cos(a) * 40, y1 = 50 + Math.sin(a) * 47;
      const x2 = 50 + Math.cos(a) * 45, y2 = 50 + Math.sin(a) * 53;
      // Left half (screen) = ticks whose x is left of centre.
      marks += `<line class="fc-tick" data-side="${Math.cos(a) < -0.05 ? 'l' : Math.cos(a) > 0.05 ? 'r' : 'c'}" data-depth="${Math.abs(Math.cos(a)).toFixed(3)}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    }
    return `<svg class="fc-ring" viewBox="0 0 100 100" aria-hidden="true"><ellipse cx="50" cy="50" rx="37" ry="44" class="fc-oval"/>${marks}</svg>`;
  }

  function paint(root, leftDone, rightDone, centreDone) {
    root.querySelectorAll('.fc-tick').forEach((t) => {
      const side = t.dataset.side, depth = Number(t.dataset.depth);
      const on = side === 'c' ? centreDone : (side === 'l' ? leftDone : rightDone) >= 1 - depth * 0.999;
      t.classList.toggle('is-on', !!on);
    });
  }

  function snapshot(video) {
    const c = document.createElement('canvas');
    const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }
  const toBlob = (canvas) => new Promise((r) => canvas.toBlob((b) => r(b), 'image/jpeg', 0.85));

  async function run({ mount, idImageUrl }) {
    mount.innerHTML = `<div class="face-check" role="group" aria-label="Face check">
      <div class="fc-stage"><video class="fc-video" playsinline muted autoplay></video>${ringSvg()}</div>
      <p class="fc-say" role="status" aria-live="polite">Getting the face check ready…</p>
      <button type="button" class="btn btn-outline fc-cancel">Cancel</button></div>`;
    const say = (t) => { mount.querySelector('.fc-say').textContent = t; };
    const video = mount.querySelector('.fc-video');
    let stream = null, cancelled = false;
    const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
    const cancelP = new Promise((_, reject) => mount.querySelector('.fc-cancel').addEventListener('click', () => { cancelled = true; stop(); reject(new Error('cancelled')); }));

    const work = (async () => {
      try {
        await load();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false });
      } catch (e) {
        stop();
        return { result: 'unsupported', score: null, selfie: null, note: 'This phone could not run the face check (no camera access, or it could not load).' };
      }
      video.srcObject = stream;
      await new Promise((r) => { if (video.readyState >= 2) r(); else video.onloadeddata = () => r(); });
      say('Checking your ID photo…');
      let idDesc = null;
      try { idDesc = await idDescriptor(idImageUrl); } catch (e) { idDesc = null; }

      let selfieCanvas = null, selfieDesc = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        let left = 0, right = 0, centre = false;
        const started = Date.now();
        say(attempt === 1 ? 'Look straight at the camera, inside the oval.' : 'Let’s try again. Look straight at the camera.');
        paint(mount, 0, 0, false);
        while (!cancelled && Date.now() - started < ATTEMPT_MS) {
          // eslint-disable-next-line no-await-in-loop
          const d = await faceapi.detectSingleFace(video, detector()).withFaceLandmarks();
          if (d) {
            // The preview is mirrored, so turning to the screen's left reads as +yaw here.
            const yaw = -yawOf(d.landmarks);
            if (!centre && Math.abs(yaw) < 0.08) {
              selfieCanvas = snapshot(video);
              // eslint-disable-next-line no-await-in-loop
              const full = await faceapi.detectSingleFace(selfieCanvas, detector()).withFaceLandmarks().withFaceDescriptor();
              if (full) { selfieDesc = full.descriptor; centre = true; say('Now slowly turn your head to the left, then to the right.'); }
            } else if (centre) {
              if (yaw < 0) left = Math.max(left, Math.min(1, -yaw / TURN));
              if (yaw > 0) right = Math.max(right, Math.min(1, yaw / TURN));
            }
            paint(mount, left, right, centre);
            if (centre && left >= 1 && right >= 1) {
              stop();
              say('Done - checking your face against your ID…');
              const selfie = await toBlob(selfieCanvas);
              if (!idDesc) return { result: 'not_matched', score: null, selfie, note: 'No face could be found on the ID photo. A Mwakete admin will check it by eye.' };
              const score = faceapi.euclideanDistance(selfieDesc, idDesc);
              return score < MATCH
                ? { result: 'passed', score, selfie, note: 'Face check passed.' }
                : { result: 'not_matched', score, selfie, note: 'Your face did not clearly match the ID photo. You can still send your application - a Mwakete admin will check it by eye.' };
            }
          } else {
            say('We can’t see your face - move into good light and fill the oval.');
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      if (cancelled) throw new Error('cancelled');
      const fallback = selfieCanvas || snapshot(video);
      stop();
      return { result: 'liveness_failed', score: null, selfie: await toBlob(fallback),
        note: 'The head-turn check did not finish after 3 tries. You can still send your application - a Mwakete admin will check your photo by eye.' };
    })();

    try { return await Promise.race([work, cancelP]); } finally { stop(); }
  }

  return { run, MATCH, TURN, _yawOf: yawOf };
})();
