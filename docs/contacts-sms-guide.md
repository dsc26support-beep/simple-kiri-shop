# Mwakete Contacts & SMS: guide for stores and admins

Mwakete Contacts & SMS lets a store keep its customer list on Mwakete.com and text the people on it. The texts go out **from the store's own Android phone and SIM**, using the store's normal SMS credit with its carrier. Mwakete does not send texts itself and does not charge for them.

Three things work together:

| Where | What it is for |
|---|---|
| **Mwakete.com** (seller dashboard → **Contacts** and **SMS**) | The list of people, their consent, groups, templates, campaigns, phones and settings. Every campaign is **started here**. |
| **Mwakete SMS app** (Android phone with the SIM) | Sends the messages the store started, one at a time, and reports back. |
| **Google Sheets add-on** (optional) | Works with the list from a Google Sheet: brings contacts in and out, drafts campaigns, pulls results. It cannot start a campaign. |

The feature is off until a Mwakete admin switches it on (see the deploy guide). Once it is on, **Contacts** and **SMS** appear in every approved store's dashboard menu.

---

## 1. Contacts (Mwakete.com → Contacts)

**Adding people**
- **Add contact**: first and last name or business name, phone, island and village, email, category, tags and notes.
- **Import**: a CSV file from a phone, Excel or Google Contacts. Row 1 must be headers; *Phone*, *First name*, *Island* and so on are recognised. Nothing is added until you have seen the check (new / already in your list / repeated / unusable number). At most 2,000 rows go in at once.
- **From my orders**: the customers who ordered from your store on Mwakete, checked the same way before they are added.
- **From a Google Sheet**: with the add-on (section 4).

**Phone numbers**
Numbers are checked with the Kiribati rule used everywhere on Mwakete: local mobiles start with 730 or 630, with or without +686. They are stored as +686…. A number that can't be used is kept and marked, so you can fix it. It is never texted.

**Duplicates**
**Possible duplicates** finds people listed twice. Merging keeps one contact, joins the details and groups, and keeps both people's consent history.

**Groups** are named lists such as "Betio customers" or "Wholesale buyers". A campaign can go to one or more groups, to everyone, or to people you pick.

**Export** downloads your list as a CSV file. Every export is recorded.

**Limits** (admin-adjustable): 10,000 contacts per store.

## 2. Consent: who may get what

Every contact has three answers: **yes**, **no** or **unknown**.

| Type of message | Needs |
|---|---|
| **Order & delivery updates** | Nothing extra. The person ordered, so they expect to hear about it. Bad numbers are still left out. |
| **Promotions** | A **yes**. |
| **Service announcements** | A **yes**. |

- A **yes** is only recorded with **how the person agreed**, for example "sign-up sheet at the shop, Oct 2026". Every change is kept in the contact's consent history: who changed it, when and why.
- **STOP replies.** If someone replies STOP, UNSUBSCRIBE, STOP ALL, CANCEL, END or QUIT (on its own, any capitals), the phone reports it. That number is then opted out of promotions and announcements for your store. Order updates still reach them.
- **Opt-out page.** People can also opt out on **mwakete.com/sms-stop.html**. It gives the same answer whatever number is typed, so nobody can use it to find out who is on a list.
- **People who opted out** (SMS → Settings) lists everyone who opted out. They are left out of every campaign automatically, even if they are imported again.

## 3. Campaigns (Mwakete.com → SMS)

1. **Connect a phone** (SMS → **Phones & SIMs**):
   - press **Get a code**;
   - on the phone, install the app (section 5) and type the code within 10 minutes;
   - the phone's SIMs then appear. You can name a SIM and type in its SMS allowance and the day it renews, so usage can be estimated.
2. **New campaign** (SMS → **Campaigns**):
   - give it a name and pick the type (order update, promotion or announcement);
   - write the message. You can use `{first_name}`, `{last_name}`, `{business_name}`, `{island}` and `{village}`, with a fallback such as `{first_name|friend}`;
   - pick who it goes to, and the phone and SIM to send from.
3. **Check**. Before anything is sent you see:
   - how many people it will reach and how many SMS it will use;
   - who is left out and why (no consent, opted out, bad number, listed twice);
   - real previews of the messages.

   The SMS count is worked out like this:
   - one SMS holds 160 plain characters, or 153 when the message is longer;
   - a special character such as ā or an emoji switches the message to 70 / 67 characters per SMS, and that character is named;
   - one message can be at most 10 SMS.
4. **Start**. You confirm the number of people. If the list changed since you checked, it refuses and asks you to check again. The campaign can start at once or at a time you choose.
5. **Watch it**. Each message shows:
   - **On the phone**: taken by the phone;
   - **Submitted to Android**;
   - **Accepted by network**: the carrier took it;
   - **Delivered**: only when the carrier sends back a delivery report;
   - **Failed**, with the reason.

   You can **Pause**, **Resume** or **Cancel** a campaign. A phone that is offline hears about a pause or cancel at its next check-in. A message it was already sending may still go.
6. **Retry** puts failures worth another try back in the queue (no signal, radio off, SIM missing, no report and similar), at most 3 tries per message. Opt-outs are checked again first.
7. **Export** downloads a campaign's results as a CSV file.

**Sending rules.** The server enforces these, and the phone checks them again:
- **Quiet hours**: no sending between 21:00 and 07:00 Kiribati time unless the store changes this.
- **A gap between messages**: 8 seconds by default, never less than 3.
- **At most 500 messages per phone per day and 1,500 per store per day.**
- **At most 1,000 people per campaign and 5 phones per store.**

An admin can change these limits.

**Your carrier's terms apply.** Messages go out on your own SIM bundle. Vodafone Kiribati / ATHKL may have fair-use or bulk-sending terms; check them. Mwakete does not claim any carrier has approved this use.

**Usage** (SMS → **Overview**) counts the SMS your phones reported, by day, phone and SIM. The remaining allowance is worked out from the allowance you typed for each SIM. Android cannot read a carrier's real balance, so treat these numbers as **estimates**.

## 4. Google Sheets add-on (optional)

1. On Mwakete.com, open SMS → Settings → **Google Sheets add-on** and press **Make a key**. Copy the key; it is shown once.
2. Install the add-on in your Google Sheet. The steps are in [`sheets-addon/README.md`](../sheets-addon/README.md).
3. In the sheet, choose **Mwakete SMS → Open panel** and paste the key.

What the add-on can do:
- **Get my contacts**;
- **add the rows of a sheet**, checked first;
- **draft a campaign** to a group, to everyone, or to the rows you selected;
- **put a campaign's results in a sheet**.

It **cannot** start or send a campaign, delete contacts, change existing contacts' consent, or see phones and settings. You start every campaign on Mwakete.com.

The key is stored in your Google account, not in the sheet. If a sheet is shared or the key leaks, remove the key on Mwakete.com; the add-on then forgets it.

## 5. The Mwakete SMS app (Android)

- **Install.** On the phone with the SIM, download **https://github.com/dsc26support-beep/simple-kiri-shop/releases/download/android-latest/mwakete-sms.apk**. The same link is on SMS → Phones & SIMs. Open the file and allow the install. The app needs Android 7 or newer. It is not on Google Play.
- **First run.**
  1. Allow SMS, phone and notification access.
  2. Type the code from Mwakete.com.
  3. Tap **Keep running in the background** and set the app to *Unrestricted* / *Don't optimise*. Otherwise Android may delay sending.
- **Day to day.**
  - The app checks in every 15 minutes, and straight away when you tap **Check now**.
  - It sends one message at a time on the SIM chosen for the campaign. It never switches to another SIM.
  - **Pause sending** stops it on this phone.
  - While it is sending, a notification shows.
- **Privacy.** The app reads incoming texts only to spot a lone STOP word. No other message leaves the phone. A SIM's own ID is sent only as a one-way code, and only the last 3 digits of its number.
- **Disconnect.**
  - **Disconnect this phone** in the app forgets the store.
  - Also remove the phone on Mwakete.com. That stops it straight away, even if the phone is lost.
- **Updates.** Until Mwakete has a release signing key, each new build must be installed after **uninstalling** the old one, and the phone connected again with a new code.

## 6. Admins (Mwakete.com → Admin → SMS)

- **Overview**: per store, counts and flags only: contacts, campaigns, sent and failed messages, opt-outs this week, phones and last seen. It shows no names, numbers or message text.
- **Suspend sending** for a store, with a reason. All its phones stop at their next check-in.
- **View a store's contacts** only with a written reason. Every view is recorded in the audit log.
- **Limits**: change the sending limits for the whole platform.

- **Campaigns** (button on each store's row): the store's campaigns that can still send, with name, type, status and counts but never the message text. **Cancel** stops one in an emergency; it asks for a reason, which goes in the audit log.
- **Phones** (open the section): every connected phone with its store, model, app and Android version, status and last check-in. Nothing it sent is shown.
- **Places** (open the section): add islands and villages, or remove ones you added. They join the built-in Kiribati list in every store's Contacts; contacts that already use a removed place keep it.

Every start, pause, cancel, consent change, import, export, phone connection and admin action is written to the audit log.
