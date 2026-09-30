/**
 * Video Call - meeting requests + join-when-ready, mounted into an existing
 * chat surface (the customer floating chat widget, or the vendor conversation
 * detail pane). Talks to Meetings.gs's requestMeeting/respondToMeeting/
 * retryMeetingSpace/cancelMeeting/endMeeting/listMeetingsForConversation.
 *
 * LAZY BY DESIGN: this file is not a static <script> tag on any page. Both
 * hosts (chat-window.js, owner-messages.js) inject it with a dynamic
 * <script> element only the first time someone opens the Video Call panel,
 * so a normal chat page - the overwhelming majority of page loads - never
 * fetches it. See loadMeetingsUi() in each host.
 *
 * BRANDING: every string here is Mwakete's own ("Video Call", "Request
 * Meeting", "Join Video Call", "Cancel Meeting", "Accept", "Decline"). The
 * underlying video provider is never named, logoed, or linked to by name
 * anywhere in this file - see meetingUrl below, which is opened as a plain
 * link with no provider chrome reproduced.
 *
 * AUTHORIZATION NOTE: every button here is a UI convenience only - who is
 * actually allowed to do what is re-checked by the backend on every action
 * (resolveActorForMeeting in Meetings.gs). Hiding a button client-side never
 * substitutes for that; it only avoids offering an action that would fail.
 */
(function () {
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function friendlyError(res) {
    return (res && res.error) || 'Something went wrong. Please try again.';
  }

  function fmtWhen(dateStr, timeStr) {
    try {
      var d = new Date(dateStr + 'T' + timeStr + ':00');
      if (isNaN(d.getTime())) return dateStr + ' ' + timeStr;
      return d.toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    } catch (e) {
      return dateStr + ' ' + timeStr;
    }
  }

  function statusLabel(m) {
    switch (m.status) {
      case 'REQUESTED': return 'Requested';
      case 'RINGING': return 'Ringing…';
      case 'ACCEPTED': return m.meetFailed ? 'Setup failed' : 'Setting up…';
      case 'READY': return 'Ready to join';
      case 'DECLINED': return 'Declined';
      case 'CANCELLED': return 'Cancelled';
      case 'ENDED': return 'Ended';
      case 'MISSED': return 'No answer';
      default: return m.status;
    }
  }

  /**
   * A bare, empty native date/time input is what made the request form read
   * as "too generic - have to guess the input": nothing on screen suggested
   * what to type or click. Pre-filling a real, valid, editable default (not
   * a placeholder, which native date/time inputs barely support anyway)
   * fixes that directly - tomorrow at the next half-hour from now, in
   * business hours (9am-6pm), clamped so it never lands overnight.
   */
  function defaultMeetingDateTime() {
    var d = new Date();
    d.setDate(d.getDate() + 1);
    var hour = Math.max(9, Math.min(18, new Date().getHours() + 1));
    d.setHours(hour, 0, 0, 0);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':00'
    };
  }

  function todayDateStr() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Local sanity checks only, so a customer/vendor gets an immediate answer
  // instead of a round trip for an obviously bad date - Meetings.gs's
  // validateMeetingRequestFields is the real, authoritative check.
  function validateDraft(purpose, date, time) {
    if (!purpose) return 'Please say what the meeting is about.';
    if (!date || !time) return 'Please choose a date and time.';
    var when = new Date(date + 'T' + time + ':00');
    if (isNaN(when.getTime())) return 'Please provide a valid date and time.';
    if (when.getTime() < Date.now() - 5 * 60 * 1000) return 'That time has already passed.';
    return null;
  }

  /**
   * ctx: {
   *   role: 'customer' | 'vendor',
   *   params(): object - the identity fields Meetings.gs's actions expect
   *             for THIS caller (storeSlug/customerToken/customerAuthToken
   *             for a customer; token/conversationId for a vendor). Read
   *             live on every call, not captured once, so a vendor switching
   *             conversations always talks about the one currently open.
   *   canRequest(): boolean - whether to show "Request Meeting" at all.
   *   signInHint: {href, label, after}|null - shown instead of the trigger
   *             when canRequest() is false, so the customer knows why rather
   *             than seeing nothing: a link (label, pointing at href)
   *             followed by trailing text (after).
   *   counterpartyName(): string|undefined - optional. The name of the
   *             OTHER party in this conversation (a store name for a
   *             customer caller, a customer's name for a vendor caller),
   *             used only in the caller's own "Calling <name>..." hint
   *             below. Falls back to a name-less "Calling..." if omitted
   *             or empty.
   * }
   */
  function mount(container, ctx) {
    var meetings = [];
    var busyMeetingId = null;

    container.innerHTML = '';
    var list = el('div', 'meeting-list');
    var formWrap = el('div', 'meeting-request-wrap');
    container.appendChild(list);
    container.appendChild(formWrap);

    function hasActiveCall() {
      return meetings.some(function (m) { return m.status === 'RINGING' || m.status === 'ACCEPTED' || m.status === 'READY'; });
    }

    function renderTrigger() {
      formWrap.innerHTML = '';
      if (!ctx.canRequest()) {
        if (ctx.signInHint) {
          var hint = el('p', 'meeting-request-signin-hint');
          var hintLink = document.createElement('a');
          hintLink.href = ctx.signInHint.href;
          hintLink.textContent = ctx.signInHint.label;
          hint.appendChild(hintLink);
          hint.appendChild(document.createTextNode(ctx.signInHint.after));
          formWrap.appendChild(hint);
        }
        return;
      }

      var row = el('div', 'meeting-trigger-row');

      // Hidden rather than disabled while a call is already ringing/connected
      // on this conversation, or a startVideoCallNow request is still in
      // flight (callNowPending) - the backend refuses a second one outright
      // (Meetings.gs's actionStartVideoCallNow), so offering a button that
      // would only ever fail is worse than not offering it.
      if (!hasActiveCall() && !callNowPending) {
        var callBtn = el('button', 'btn btn-primary', 'Video Call Now');
        callBtn.type = 'button';
        callBtn.addEventListener('click', startCallNow);
        row.appendChild(callBtn);
      }

      var btn = el('button', 'btn meeting-request-trigger', 'Request Meeting');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        formWrap.innerHTML = '';
        formWrap.appendChild(renderForm());
      });
      row.appendChild(btn);

      formWrap.appendChild(row);
    }

    /**
     * "Video Call Now" - starts RINGING immediately, no purpose/date/time.
     * Also reused as "Call Again" on a MISSED card (same action, fresh call).
     * The recipient finds out via the incoming-call banner their own chat
     * window/owner-messages.js already renders from the SAME poll this panel
     * itself uses (Chat.gs's getConversation), not from anything in this file.
     */
    // Guards the gap between a tap and the response landing - without it, a
    // double-tap (easy to trigger on mobile with any network lag) fires two
    // startVideoCallNow requests; the first creates the RINGING call, the
    // second hits the backend's own one-call-per-conversation guard and
    // surfaces as a spurious "already an active video call" alert for what
    // the customer experienced as a single tap.
    var callNowPending = false;
    function startCallNow() {
      if (callNowPending) return;
      callNowPending = true;
      renderTrigger();
      return Api.post('startVideoCallNow', ctx.params()).then(function (res) {
        callNowPending = false;
        if (!res.ok) {
          alert(friendlyError(res));
          renderTrigger();
          return;
        }
        var idx = meetings.findIndex(function (m) { return m.meetingId === res.meeting.meetingId; });
        if (idx === -1) meetings.push(res.meeting); else meetings[idx] = res.meeting;
        render();
      });
    }

    function renderForm() {
      var form = el('form', 'meeting-request-form');

      form.appendChild(el('label', 'meeting-request-label', 'Purpose'));
      var purpose = document.createElement('textarea');
      purpose.className = 'meeting-request-input';
      purpose.placeholder = 'What is this meeting about?';
      purpose.maxLength = 500;
      form.appendChild(purpose);

      form.appendChild(el('label', 'meeting-request-label', 'Notes (optional)'));
      var notes = document.createElement('textarea');
      notes.className = 'meeting-request-input';
      notes.placeholder = 'Anything else to add?';
      notes.maxLength = 1000;
      form.appendChild(notes);

      var row = el('div', 'meeting-request-datetime-row');
      var dateField = el('div', 'meeting-request-datetime-field');
      dateField.appendChild(el('label', 'meeting-request-label', 'Date'));
      var dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.className = 'meeting-request-input';
      dateInput.min = todayDateStr(); // can't be picked before it's even rendered - matches the backend's own "not in the past" check
      dateField.appendChild(dateInput);
      row.appendChild(dateField);

      var timeField = el('div', 'meeting-request-datetime-field');
      timeField.appendChild(el('label', 'meeting-request-label', 'Time'));
      var timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.className = 'meeting-request-input';
      timeInput.step = 1800; // 30-minute increments on the native picker, rather than a fiddly to-the-minute scroll
      timeField.appendChild(timeInput);
      row.appendChild(timeField);
      form.appendChild(row);

      var defaults = defaultMeetingDateTime();
      dateInput.value = defaults.date;
      timeInput.value = defaults.time;

      var err = el('p', 'meeting-request-error hidden');
      form.appendChild(err);

      var actions = el('div', 'meeting-request-actions');
      var submitBtn = el('button', 'btn btn-primary meeting-request-submit', 'Send Request');
      submitBtn.type = 'submit';
      var cancelBtn = el('button', 'btn', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', renderTrigger);
      actions.appendChild(submitBtn);
      actions.appendChild(cancelBtn);
      form.appendChild(actions);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var problem = validateDraft(purpose.value.trim(), dateInput.value, timeInput.value);
        if (problem) {
          err.textContent = problem;
          err.classList.remove('hidden');
          return;
        }
        err.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';

        var params = Object.assign({}, ctx.params(), {
          purpose: purpose.value.trim(),
          notes: notes.value.trim(),
          requestedDate: dateInput.value,
          requestedTime: timeInput.value
        });

        Api.post('requestMeeting', params).then(function (res) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Request';
          if (!res.ok) {
            err.textContent = friendlyError(res);
            err.classList.remove('hidden');
            return;
          }
          meetings.push(res.meeting);
          renderTrigger();
          render();
        });
      });

      return form;
    }

    function actionButton(label, cls, disabled, onClick) {
      var b = el('button', 'btn ' + (cls || ''), label);
      b.type = 'button';
      if (disabled) b.disabled = true;
      b.addEventListener('click', onClick);
      return b;
    }

    function callAction(action, meetingId, extra) {
      busyMeetingId = meetingId;
      render();
      var params = Object.assign({}, ctx.params(), { meetingId: meetingId }, extra || {});
      return Api.post(action, params).then(function (res) {
        busyMeetingId = null;
        if (!res.ok) {
          alert(friendlyError(res));
          render();
          return;
        }
        if (res.meeting) {
          var idx = meetings.findIndex(function (m) { return m.meetingId === meetingId; });
          if (idx !== -1) meetings[idx] = res.meeting;
          render();
        } else {
          refresh();
        }
      });
    }

    function renderCard(m) {
      var card = el('div', 'meeting-card meeting-card--' + m.status.toLowerCase());
      var top = el('div', 'meeting-card-top');
      top.appendChild(el('span', 'meeting-card-purpose', m.purpose));
      top.appendChild(el('span', 'meeting-card-status', statusLabel(m)));
      card.appendChild(top);
      // A Video Call Now carries no scheduled date/time (see Meetings.gs's
      // isNowCall) - nothing to print for it here.
      if (m.requestedDate) card.appendChild(el('p', 'meeting-card-when', fmtWhen(m.requestedDate, m.requestedTime)));
      if (m.notes) card.appendChild(el('p', 'meeting-card-notes', m.notes));

      var isBusy = busyMeetingId === m.meetingId;
      var isRecipient = m.recipientType === ctx.role;
      var actions = el('div', 'meeting-card-actions');

      if ((m.status === 'REQUESTED' || m.status === 'RINGING') && isRecipient) {
        actions.appendChild(actionButton('Accept', 'btn-primary', isBusy, function () {
          callAction('respondToMeeting', m.meetingId, { accept: true });
        }));
        actions.appendChild(actionButton('Decline', '', isBusy, function () {
          callAction('respondToMeeting', m.meetingId, { accept: false });
        }));
      } else if (m.status === 'RINGING') {
        var callingHint = el('p', 'meeting-card-hint meeting-card-hint--calling');
        var counterpartyName = (typeof ctx.counterpartyName === 'function' && ctx.counterpartyName()) || '';
        callingHint.appendChild(document.createTextNode(counterpartyName ? 'Calling ' + counterpartyName : 'Calling'));
        var dots = el('span', 'meeting-calling-dots');
        dots.appendChild(el('span', 'meeting-calling-dot meeting-calling-dot--1'));
        dots.appendChild(el('span', 'meeting-calling-dot meeting-calling-dot--2'));
        dots.appendChild(el('span', 'meeting-calling-dot meeting-calling-dot--3'));
        callingHint.appendChild(dots);
        if (m.ringingSecondsLeft != null) callingHint.appendChild(document.createTextNode(' (' + m.ringingSecondsLeft + 's)'));
        card.appendChild(callingHint);
      }

      if (m.status === 'MISSED') {
        card.appendChild(el('p', 'meeting-card-hint', 'No answer.'));
        actions.appendChild(actionButton('Call Again', 'btn-primary', isBusy || callNowPending, startCallNow));
      }

      if (m.status === 'ACCEPTED' && m.meetFailed) {
        card.appendChild(el('p', 'meeting-card-error', "We couldn't set up the video call."));
        actions.appendChild(actionButton('Retry', 'btn-primary', isBusy, function () {
          callAction('retryMeetingSpace', m.meetingId);
        }));
      } else if (m.status === 'ACCEPTED') {
        card.appendChild(el('p', 'meeting-card-hint', 'Setting up the video call…'));
      }

      // https:// only, even though the backend only ever fills this from its
      // own trusted API response (never from anything a browser sent) - one
      // more guard against a link this file didn't expect ever being handed
      // to a customer or vendor as something safe to click.
      if (m.status === 'READY' && m.meetingUrl && /^https:\/\//.test(m.meetingUrl)) {
        var join = el('a', 'btn btn-primary', 'Join Video Call');
        join.href = m.meetingUrl;
        join.target = '_blank';
        join.rel = 'noopener';
        actions.appendChild(join);
        actions.appendChild(actionButton('End Meeting', '', isBusy, function () {
          if (confirm('End this meeting?')) callAction('endMeeting', m.meetingId);
        }));
      }

      // A RINGING call already offers Decline to its recipient above - Cancel
      // alongside it would be a redundant second way to do the same thing, so
      // only the CALLER gets Cancel (hang up) while it's still ringing.
      if (m.status === 'REQUESTED' || m.status === 'ACCEPTED' || m.status === 'READY' ||
          (m.status === 'RINGING' && !isRecipient)) {
        actions.appendChild(actionButton('Cancel Meeting', 'btn-danger', isBusy, function () {
          if (confirm('Cancel this meeting?')) callAction('cancelMeeting', m.meetingId);
        }));
      }

      if (actions.children.length) card.appendChild(actions);
      return card;
    }

    function render() {
      list.innerHTML = '';
      if (meetings.length === 0) {
        list.appendChild(el('p', 'meeting-empty-state', 'No meetings yet.'));
      } else {
        // Oldest requested first at the bottom, most relevant (newest) on top -
        // the same ordering direction as everywhere else this matters less; a
        // meeting list is short enough that recency, not history, is what
        // someone opening this panel wants to see first.
        meetings.slice().reverse().forEach(function (m) { list.appendChild(renderCard(m)); });
      }
      // A card list re-render must never clobber an in-progress request-form
      // draft sitting in formWrap - only refresh the trigger area when it's
      // actually showing the trigger, not the open form.
      if (!formWrap.querySelector('.meeting-request-form')) renderTrigger();
      scheduleRingPollIfNeeded();
      reconcileRingingSound();
    }

    // Both the caller (this panel) and the recipient hear a repeating ring
    // while a meeting is RINGING (see the caller's own "Calling..." hint
    // above) - RingingLoop.start is a no-op if that meetingId is already
    // looping, so calling it on every render is cheap and idempotent.
    // stopExcept clears any id that stopped ringing (answered, declined,
    // cancelled, or timed out to MISSED) without this panel needing to
    // track "was this one playing" itself.
    function reconcileRingingSound() {
      var ringingIds = meetings.filter(function (m) { return m.status === 'RINGING'; })
        .map(function (m) { return m.meetingId; });
      ringingIds.forEach(function (id) { RingingLoop.start(id); });
      RingingLoop.stopExcept(ringingIds);
    }

    /**
     * A RINGING call is the one state worth polling faster than the host's
     * own 5-20s chat cadence for - the caller is actively watching this
     * panel for pickup, same class of "poll only while doing something that
     * needs it" as the chat window's own message poll while open. Bounded:
     * stops the moment nothing is RINGING any more, and stop() (returned
     * from mount) cancels it outright when the panel closes.
     */
    var ringPollTimer = null;
    function hasPendingRing() {
      return meetings.some(function (m) { return m.status === 'RINGING'; });
    }
    function scheduleRingPollIfNeeded() {
      if (ringPollTimer || !hasPendingRing()) return;
      ringPollTimer = setTimeout(function () {
        ringPollTimer = null;
        refresh();
      }, 3000);
    }
    function stopRingPolling() {
      if (ringPollTimer) { clearTimeout(ringPollTimer); ringPollTimer = null; }
      RingingLoop.stopAll();
    }

    function refresh() {
      return Api.post('listMeetingsForConversation', ctx.params()).then(function (res) {
        if (!res.ok) {
          list.innerHTML = '';
          list.appendChild(el('p', 'meeting-empty-state', "Couldn't load meetings. Please try again."));
          return;
        }
        meetings = res.meetings || [];
        render();
      });
    }

    renderTrigger();
    refresh();

    return { stop: stopRingPolling };
  }

  window.MwaketeMeetings = { mount: mount };
})();
