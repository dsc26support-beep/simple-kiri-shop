// Chat window UI shell - NOT connected to the backend yet. No Api.get/Api.post
// calls anywhere in this file. The "loading conversation", vendor reply, and
// unread badge are all local, scripted demo behavior standing in for real
// data until sendMessage/getConversation get wired up in a later pass.
document.addEventListener('DOMContentLoaded', initChatWindow);

function initChatWindow() {
  const fab = document.getElementById('chat-fab');
  const win = document.getElementById('chat-window');
  if (!fab || !win) return;

  const closeBtn = document.getElementById('chat-window-close');
  const body = document.getElementById('chat-window-body');
  const loadingEl = document.getElementById('chat-loading');
  const messagesEl = document.getElementById('chat-messages');
  const typingEl = document.getElementById('chat-typing');
  const form = document.getElementById('chat-window-form');
  const input = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const badge = document.getElementById('chat-unread-badge');

  let hasLoadedOnce = false;
  let isOpen = false;

  function scrollMessagesToBottom() {
    body.scrollTop = body.scrollHeight;
  }

  function openWindow() {
    isOpen = true;
    win.classList.add('chat-window--open');
    win.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');

    // Opening the chat is treated as reading it, same as any chat app - purely
    // local state, no markAsRead call since there's nothing to sync yet.
    if (badge) badge.classList.add('hidden');

    if (!hasLoadedOnce) {
      hasLoadedOnce = true;
      loadingEl.classList.remove('hidden');
      messagesEl.classList.add('hidden');
      // Simulated load delay so the loading indicator is actually visible -
      // stands in for the future getConversation() call.
      setTimeout(() => {
        loadingEl.classList.add('hidden');
        messagesEl.classList.remove('hidden');
        scrollMessagesToBottom();
      }, 650);
    }

    setTimeout(() => input.focus(), 220); // after the open transition
  }

  function closeWindow() {
    isOpen = false;
    win.classList.remove('chat-window--open');
    win.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
    fab.focus();
  }

  fab.setAttribute('aria-haspopup', 'dialog');
  fab.setAttribute('aria-expanded', 'false');
  win.setAttribute('aria-hidden', 'true');

  fab.addEventListener('click', () => {
    if (isOpen) closeWindow();
    else openWindow();
  });

  closeBtn.addEventListener('click', closeWindow);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeWindow();
  });

  function appendMessage(senderClass, text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-message ' + senderClass;
    const p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
    messagesEl.appendChild(bubble);
    scrollMessagesToBottom();
  }

  function autoResizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  }
  input.addEventListener('input', autoResizeInput);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Sending here is a purely local echo + a scripted canned reply - there is
  // no conversation being persisted anywhere. Replace with a real
  // sendMessage()/getConversation() call once the backend is wired up.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    appendMessage('chat-message--customer', text);
    input.value = '';
    autoResizeInput();

    typingEl.classList.remove('hidden');
    messagesEl.appendChild(typingEl);
    scrollMessagesToBottom();

    setTimeout(() => {
      typingEl.classList.add('hidden');
      appendMessage('chat-message--vendor', "Thanks for your message! We'll get back to you soon.");
    }, 1400);
  });
}
