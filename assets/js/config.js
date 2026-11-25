// The one line every deployment needs to edit: paste in your deployed
// Google Apps Script Web App URL (ends in /exec). See README.md.
const APP_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec',
  CURRENCY_SYMBOL: '$',
  SITE_NAME: 'Mwakete',

  // Google Sign-In. This is a PUBLIC client id, not a secret - it is designed
  // to be readable in the page, and Google enforces which origins may use it.
  // The matching GOOGLE_CLIENT_ID must also be set in Apps Script Script
  // Properties, because that is what the server checks the token's `aud`
  // against. Leave this empty and the Google button simply does not appear;
  // email codes and guest checkout are unaffected. See README.
  GOOGLE_CLIENT_ID: '777287788123-6e77qgq38m2bu46pmtril0687qiccit1.apps.googleusercontent.com',

  // Facebook Login (customers only). The App ID is PUBLIC, like the Google
  // client id - never put the App SECRET here; that lives only in Apps Script
  // Script Properties (FACEBOOK_APP_SECRET). Empty = no Facebook button.
  // See docs/auth-meta-setup.md.
  FACEBOOK_APP_ID: '',

  // Web Push (Firebase Cloud Messaging), CESN. Every value here is PUBLIC - the
  // Firebase web config and the VAPID PUBLIC key. NEVER put a private key here;
  // the service-account key lives only in Apps Script Script Properties
  // (FCM_SERVICE_ACCOUNT). Leave this null and the "Turn on notifications"
  // button never appears and no Firebase code loads - the in-app Notification
  // Centre still works. To enable, set it to the object the owner gets from the
  // Firebase console (see docs/cesn-architecture.md section 5.1), e.g.:
  //   PUSH_CONFIG: { apiKey: '...', projectId: '...', appId: '...',
  //                  messagingSenderId: '...', vapidKey: '...' }
  PUSH_CONFIG: null
};
