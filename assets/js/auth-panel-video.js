// The welcome video in the purple panel on the sign-in pages
// (customer-login.html, owner/login.html, owner/forgot-password.html).
//
// The panel only shows the video on a computer (900px+); on phones it is a
// slim text band. So the sources and poster live in data- attributes and are
// added here only on a wide screen - a phone never downloads the ~1 MB file.
// If someone has "reduce motion" on, the first frame shows and it never plays.
// With no JavaScript the panel keeps its headline on purple.
(function () {
  var video = document.querySelector('.auth-panel-video video');
  if (!video || !window.matchMedia) return;
  var panel = video.closest('.auth-split-panel');
  var wide = window.matchMedia('(min-width: 900px)');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');
  var ready = false;

  function play() {
    if (still.matches || !wide.matches) { video.pause(); return; }
    var p = video.play();
    if (p && p.catch) p.catch(function () { /* autoplay refused: the poster stays */ });
  }

  function setUp() {
    if (ready || !wide.matches) return;
    ready = true;
    video.poster = video.getAttribute('data-poster');
    [['data-webm', 'video/webm'], ['data-mp4', 'video/mp4']].forEach(function (s) {
      var source = document.createElement('source');
      source.src = video.getAttribute(s[0]);
      source.type = s[1];
      video.appendChild(source);
    });
    video.preload = 'auto';
    video.load();
    panel.classList.add('has-video');
    play();
  }

  function onChange() { setUp(); play(); }
  [wide, still].forEach(function (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  });
  setUp();
})();
