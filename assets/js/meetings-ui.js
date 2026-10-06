/**
 * Meetings - meeting requests (ask for a date/time, accept or decline,
 * arrange the rest in chat), mounted into an existing chat surface (the customer floating chat widget, or the vendor conversation
 * detail pane). Talks to Meetings.gs's requestMeeting/respondToMeeting/
 * retryMeetingSpace/cancelMeeting/endMeeting/listMeetingsForConversation.
 *
 * LAZY BY DESIGN: this file is not a static <script> tag on any page. Both
 * hosts (chat-window.js, owner-messages.js) inject it with a dynamic
 * <script> element only the first time someone opens the Meetings panel,
 * so a normal chat page - the overwhelming majority of page loads - never
 * fetches it. See loadMeetingsUi() in each host.
 *
 * NO VIDEO: video calling was removed (owner decision, Oct 2026). There is
 * no instant call, no ringing and no join link - an accepted meeting is just
 * a confirmed date/time the two parties arrange in chat. Meetings.gs answers
 * the old video actions with a plain failure.
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
      case 'ACCEPTED':
      case 'READY': return 'Accepted';
      case 'DECLINED': return 'Declined';
      case 'CANCELLED': return 'Cancelled';
      case 'ENDED': return 'Ended';
      case 'MISSED': return 'Missed call';
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
   *   signInUrl: string|function|null - when canRequest() is false, "Request
   *             Meeting" still shows and sends the customer here (the sign-in
   *             page, which explains why and brings them straight back).
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

    function renderTrigger() {
      formWrap.innerHTML = '';
      var btn = el('button', 'btn btn-primary meeting-request-trigger', 'Request Meeting');
      btn.type = 'button';
      if (!ctx.canRequest()) {
        // Signed out: same button, but it goes to sign-in rather than to a
        // form whose submit the backend would refuse. The sign-in page says
        // why they're there, and returns them to this panel afterwards.
        if (!ctx.signInUrl) return;
        btn.addEventListener('click', function () {
          window.location.href = typeof ctx.signInUrl === 'function' ? ctx.signInUrl() : ctx.signInUrl;
        });
        formWrap.appendChild(btn);
        return;
      }
      btn.addEventListener('click', function () {
        formWrap.innerHTML = '';
        formWrap.appendChild(renderForm());
      });
      formWrap.appendChild(btn);
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
      // Old "Video Call Now" rows carry no date/time - nothing to print.
      if (m.requestedDate) card.appendChild(el('p', 'meeting-card-when', fmtWhen(m.requestedDate, m.requestedTime)));
      if (m.notes) card.appendChild(el('p', 'meeting-card-notes', m.notes));

      var isBusy = busyMeetingId === m.meetingId;
      var isRecipient = m.recipientType === ctx.role;
      var actions = el('div', 'meeting-card-actions');

      if (m.status === 'REQUESTED' && isRecipient) {
        actions.appendChild(actionButton('Accept', 'btn-primary', isBusy, function () {
          callAction('respondToMeeting', m.meetingId, { accept: true });
        }));
        actions.appendChild(actionButton('Decline', '', isBusy, function () {
          callAction('respondToMeeting', m.meetingId, { accept: false });
        }));
      }

      if (m.status === 'ACCEPTED' || m.status === 'READY') {
        card.appendChild(el('p', 'meeting-card-hint', 'Accepted - arrange the details in chat.'));
      }

      if (m.status === 'REQUESTED' || m.status === 'ACCEPTED' || m.status === 'READY') {
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
        // Newest on top - a meeting list is short, and recency is what
        // someone opening this panel wants first.
        meetings.slice().reverse().forEach(function (m) { list.appendChild(renderCard(m)); });
      }
      // Never clobber an in-progress request-form draft sitting in formWrap.
      if (!formWrap.querySelector('.meeting-request-form')) renderTrigger();
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

    return { stop: function () {} };
  }

  window.MwaketeMeetings = { mount: mount };
})();
