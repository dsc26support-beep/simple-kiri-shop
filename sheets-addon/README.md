# Mwakete SMS for Google Sheets

Work with your Mwakete contacts and SMS campaigns from a Google Sheet:

- **Get my contacts**: puts all your contacts into a sheet called “Mwakete contacts”. The sheet is replaced each time.
- **Add rows from a sheet**: checks the rows first (new, already in your contacts, repeated, no usable number), then adds them. It can add them to a group. It records that people agreed to promotions **only** if you tick that box and say how they agreed.
- **Draft a campaign**: to a group, to all contacts, or to the rows you selected in “Mwakete contacts”. It shows who will get it and how many SMS it uses, then saves a **draft**.
- **Campaign results**: puts a campaign's results (sent, delivered, failed) into a sheet.

The add-on can **never start or send a campaign**. You check every draft and press **Start** on Mwakete.com. It also cannot delete contacts, change the consent of people already in your contacts, or see your phones or settings. Mwakete's backend enforces this for add-on keys (`SMS_ACTIONS` in `apps-script/SmsCampaigns.gs`).

## Install (in your own Google Sheet, no Marketplace needed)

1. On Mwakete.com, go to **SMS → Settings → Google Sheets add-on**. Give the key a name and press **Make a key**. Copy the key; it is shown only once.
2. Open (or create) a Google Sheet. Choose **Extensions → Apps Script**.
3. In the Apps Script editor:
   - Replace the contents of `Code.gs` with this folder's [`Code.gs`](Code.gs).
   - Choose **+ → HTML**, name the file `Sidebar` and paste [`Sidebar.html`](Sidebar.html).
   - Under **Project Settings**, tick **Show "appsscript.json" manifest file**. Then replace that file's contents with [`appsscript.json`](appsscript.json).
   - Press **Save**.
4. Reload the sheet. A **Mwakete SMS** menu appears. Choose **Mwakete SMS → Open panel**.
5. Google asks you to allow the script. It only gets access to:
   - this spreadsheet;
   - showing its menu and panel;
   - talking to Mwakete.com.

   Press **Allow**.
6. Paste your key and press **Connect**.

The key is kept in **your Google account's** settings for this script, not in the sheet. Other people you share the sheet with do not get it.

If a sheet with the add-on is shared or the key leaks, remove the key on Mwakete.com (**SMS → Settings**). The add-on then forgets it and asks again.

## Sheet layout for adding contacts

Row 1 holds the headers. The usual names are recognised:

| Field | Header names that work |
|---|---|
| First name | First name, Given name, Name |
| Last name | Last name, Surname |
| Business | Business, Company, Store |
| Phone | Phone, Mobile, Number, Tel |
| Island | Island |
| Village | Village, Town |
| Email | Email |
| Category | Category, Type |
| Notes | Notes |

Numbers are checked with the same Kiribati rule as the rest of Mwakete: local numbers starting with 730 or 630, with or without +686. At most 2,000 rows go in one go.

## Limits

- Messages go out from **your own phone and SIM** (the Mwakete SMS Android app), under your carrier's terms. The add-on only drafts them.
- This is installed per sheet (the "bound script" way). Publishing it on the Google Workspace Marketplace would need a Google Cloud project and Google's review, and has not been done.
- Tested automatically against the real backend code (`tests/test-sheets-addon.js`), but not yet in a live Google Sheet. The first real install is the live test.
