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
  GOOGLE_CLIENT_ID: '777287788123-6e77qgq38m2bu46pmtril0687qiccit1.apps.googleusercontent.com'
};
