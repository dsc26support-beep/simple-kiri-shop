# Facebook Login and Google sign-in — setup (owner tasks)

Facebook sign-in is **built but switched off**. It stays off (no button, and
the server refuses every Facebook token) until both of these are true:

- `FACEBOOK_APP_ID` is set in `assets/js/config.js`. This is public.
- `FACEBOOK_APP_ID` **and** `FACEBOOK_APP_SECRET` are set in Apps Script
  Script Properties. The secret is private.

Nothing here costs money. Creating a Meta app is a commitment made in
Mwakete's name, though, so it is the owner's step. Claude cannot do it.

## 1. Create the Meta app

1. Go to <https://developers.facebook.com/> and log in with the Facebook
   account that should own the app. Use a business or admin account, not a
   personal one that might be closed.
2. Choose **My Apps → Create App**.
3. **Use case:** pick **Authenticate and request data from users with Facebook
   Login**.
4. **App name:** `Mwakete`.
5. **Contact email:** an address you read, such as `admin@mwakete.com`.
6. When asked, add the **Facebook Login** product, using the **Web** platform.

## 2. Configure Facebook Login

Under **Facebook Login → Settings**:

| Setting | Value |
|---|---|
| Client OAuth login | Yes |
| Web OAuth login | Yes |
| Login with the JavaScript SDK | **Yes** |
| Allowed Domains for the JavaScript SDK | `https://mwakete.com` (and `https://www.mwakete.com` if used) |
| Valid OAuth Redirect URIs | `https://mwakete.com/customer-login.html` |
| Enforce HTTPS | Yes |

Then go to **App settings → Basic**:

| Field | Value |
|---|---|
| App domains | `mwakete.com` |
| Privacy Policy URL | `https://mwakete.com/privacy.html` |
| Terms of Service URL | `https://mwakete.com/terms.html` |
| User data deletion | **Data deletion instructions URL** → `https://mwakete.com/data-deletion.html` |
| Category | Shopping |
| App icon | the Mwakete logo (1024×1024) |

**Before you paste the deletion URL**, read `privacy.html` and
`data-deletion.html`. Both are marked DRAFT in their source and need your
approval. They promise deletion within 30 days, done by email to
admin@mwakete.com, and someone has to actually do that.

## 3. Permissions

Only `public_profile` and `email` are requested. These are standard
permissions and are granted for Facebook Login without App Review. Do not add
any others.

## 4. Copy the IDs to Mwakete

1. On **App settings → Basic**, copy the **App ID** and the **App Secret**
   (click *Show*; Facebook asks for your password).
2. **Apps Script** → Project Settings → Script Properties. Add:
   - `FACEBOOK_APP_ID` = the App ID
   - `FACEBOOK_APP_SECRET` = the App Secret. **Never put this anywhere else:**
     not in GitHub, not in `config.js`, not in a chat.
   - `FACEBOOK_GRAPH_VERSION` = the version your app dashboard shows, e.g.
     `v23.0` (optional; `v23.0` is the default).
3. In GitHub, edit `assets/js/config.js` and set
   `FACEBOOK_APP_ID: '<the App ID>'`. Then rebuild (`npm run build`) and
   bump `CACHE` in `sw.js`. Or ask Claude to make that commit.

## 5. Go live and test

1. In the Meta dashboard, switch the app from **Development** to **Live**.
   While it is in Development, only people listed under App roles can use it.
   That is useful for a first test.
2. Test on a phone and on a computer:
   - Open `https://mwakete.com/customer-login.html`. **Continue with
     Facebook** should be shown.
   - Use a Facebook account whose email is **not** a Mwakete account. A new
     account is made, and a 6-digit code goes to that email. Confirm it. Until
     then the account can browse but not order.
   - Use a Facebook account whose email **is** already a Mwakete account. The
     page says to sign in to that account once with its password or a code,
     then Facebook is linked.
   - In My Account → Sign-in & security: unlink Facebook, then link it again.
3. If something fails, the message on the page says what went wrong. The
   Apps Script **Executions** log shows the action name. Tokens are never
   logged.

## Google sign-in (already set up)

Google sign-in is already configured: the `GOOGLE_CLIENT_ID` is in
`config.js` and in Script Properties. What changed:

- The server now also requires Google's `sub` (user id).
- A Google sign-in whose email matches an existing account no longer merges
  into it automatically. The shopper proves the account first.

Shoppers who already signed in with Google before this change keep signing
straight in. Their link is moved to the new `ProviderIdentities` sheet the
first time they use it.

In Google Cloud Console → APIs & Services → OAuth consent screen, make sure
these are set:

- **Privacy policy:** `https://mwakete.com/privacy.html`
- **Authorized JavaScript origins:** include `https://mwakete.com`
