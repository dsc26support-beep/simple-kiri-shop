// "Help?" for the Facebook Messenger box (Register Store, Store Settings and
// Drive with Mwakete) - owner requests, Oct 2026. The button sits inside the
// box at its right edge. Pressing it shows one line of steps under the box,
// and pressing it again hides it. Where the box has a note under it
// ([data-fb-help-swap], e.g. "Mwakete will contact you on Messenger...") the
// steps take the note's place while they show, and the note comes back after.
// It replaced a popup that sent sellers off to Facebook's Help Center: the
// steps are short enough to just say.
(function () {
  const STEPS = 'Open Messenger > Menu > Settings > Username, then enter m.me/your-username';

  function toggle(btn) {
    const field = btn.closest('.field') || btn.parentNode;
    const input = field.querySelector('input');
    const note = field.querySelector('[data-fb-help-swap]');
    let line = field.querySelector('.fbh-steps');
    if (!line) {
      line = document.createElement('p');
      line.className = 'helper-text fbh-steps';
      line.id = ((input && input.id) || 'messenger') + '-steps';
      line.textContent = STEPS;
      line.hidden = true;
      if (note) note.after(line); else field.appendChild(line);
      btn.setAttribute('aria-controls', line.id);
    }
    line.hidden = !line.hidden;
    if (note) note.hidden = !line.hidden;
    btn.setAttribute('aria-expanded', line.hidden ? 'false' : 'true');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fb-help]');
    if (!btn) return;
    e.preventDefault();
    toggle(btn);
  });
})();
