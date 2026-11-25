/**
 * Firebase Cloud Messaging background handler (CESN Stage 3). DORMANT: this
 * service worker is only ever registered by assets/js/push-register.js, and
 * only when the owner has set APP_CONFIG.PUSH_CONFIG and a shopper taps "Turn
 * on notifications". It is separate from the main sw.js (the app shell cache)
 * and does not touch it. The (public) Firebase config arrives in the query
 * string, so this file needs no editing.
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

var p = new URLSearchParams(self.location.search);
firebase.initializeApp({
  apiKey: p.get('apiKey'),
  projectId: p.get('projectId'),
  messagingSenderId: p.get('messagingSenderId'),
  appId: p.get('appId')
});

var messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  var n = (payload && payload.notification) || {};
  var link = (payload && payload.fcmOptions && payload.fcmOptions.link) ||
    (payload && payload.data && payload.data.link) || '/';
  self.registration.showNotification(n.title || 'Mwakete', {
    body: n.body || '',
    icon: 'assets/img/app-icon-192.png',
    badge: 'assets/img/app-icon-192.png',
    data: { link: link }
  });
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(clients.openWindow(link));
});
