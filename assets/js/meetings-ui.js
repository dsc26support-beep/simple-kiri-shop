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
      case 'ACCEPTED': return m.meetFailed ? 'Setup failed' : 'Setting up…';
      case 'READY': return 'Ready to join';
      case 'DECLINED': return 'Declined';
      case 'CANCELLED': return 'Cancelled';
      case 'ENDED': return 'Ended';
      default: return m.status;
    }
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
   *   signInHint: string|null - shown instead of the trigger when canRequest()
   *             is false, so the customer knows why rather than seeing nothing.
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
      if (ctx.canRequest()) {
        var btn = el('button', 'btn btn-small meeting-request-trigger', 'Request Meeting');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          formWrap.innerHTML = '';
          formWrap.appendChild(renderForm());
        });
        formWrap.appendChild(btn);
      } else if (ctx.signInHint) {
        formWrap.appendChild(el('p', 'meeting-request-signin-hint', ctx.signInHint));
      }
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

      form.appendChild(el('label', 'meeting-request-label', 'Date & time'));
      var row = el('div', 'meeting-request-datetime-row');
      var dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.className = 'meeting-request-input';
      var timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.className = 'meeting-request-input';
      row.appendChild(dateInput);
      row.appendChild(timeInput);
      form.appendChild(row);

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
      card.appendChild(el('p', 'meeting-card-when', fmtWhen(m.requestedDate, m.requestedTime)));
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
        return;
      }
      // Oldest requested first at the bottom, most relevant (newest) on top -
      // the same ordering direction as everywhere else this matters less; a
      // meeting list is short enough that recency, not history, is what
      // someone opening this panel wants to see first.
      meetings.slice().reverse().forEach(function (m) { list.appendChild(renderCard(m)); });
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
  }

  window.MwaketeMeetings = { mount: mount };
})();
