/**
 * Where a one-time code goes out.
 *
 * Every vendor auth code - login 2FA, 2FA setup, password reset - is minted in
 * one place (issueTwoFACode, Auth.gs) and until now went straight to
 * sendAppEmail. This file is the seam between "make a code" and "put it in
 * front of a human", so a second channel can be added without touching any of
 * Auth.gs's flow logic.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SMS HERE YET
 *
 * Email is free and needs nobody: sendAppEmail (Utils.gs) uses Apps Script's
 * own MailApp, no account, no key, no cost. Its ceiling is ~100 emails/day on a
 * consumer Gmail account and 1,500/day on Workspace - already recorded as
 * Finding 9 in docs/production-readiness-report.md, and the reason the optional
 * Resend swap exists.
 *
 * SMS has no equivalent. Putting a text on a phone means getting onto a
 * carrier's network, and there are exactly three doors:
 *
 *   1. A gateway API (Twilio, Vonage, AWS SNS). Works today, costs real money
 *      per message, and is a third party holding your traffic. Needs +686
 *      routing confirmed before anyone writes code against it.
 *   2. A carrier email-to-SMS bridge - send mail to something like
 *      73007552@<carrier-domain> and it lands as a text. Free, and it would
 *      reuse sendAppEmail untouched. Whether ATH Kiribati publishes one is a
 *      question for ATH, not for this file.
 *   3. A spare Android phone with a SIM, polling this backend for queued
 *      messages and sending them itself. No monthly bill, but it is a machine
 *      someone has to keep powered, online and unlocked.
 *
 * Door 2 is the one worth asking about first: if it exists, sendSms below
 * becomes a two-line call to sendAppEmail and nothing else in this file moves.
 *
 * Until one of those is real, sendSms returns false and every request falls
 * back to email. That fallback is the whole safety story: a vendor who somehow
 * ends up with AuthChannel = 'sms' must still be able to log in.
 * ---------------------------------------------------------------------------
 */

/** Script Property that will hold SMS sender config once a door above is chosen. */
var SMS_CONFIG_PROPERTY = 'SMS_SENDER';

/**
 * True only when a real SMS sender is configured. False on every deployment
 * today, which is what makes the fallback below unconditional in practice.
 *
 * Deliberately reads a Script Property rather than a hardcoded false: turning
 * SMS on should be a deployment decision, the same shape as the existing
 * RESEND_API_KEY and CLOUDINARY opt-ins, not a code edit.
 */
function smsSenderConfigured() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SMS_CONFIG_PROPERTY);
    return !!(raw && String(raw).trim());
  } catch (e) {
    // A Properties failure must never take out the login path.
    return false;
  }
}

/**
 * Send one SMS. Stub.
 *
 * Returns false rather than throwing, and never throws for any input, because
 * its only caller is on the login path: an exception here would turn "SMS is
 * not set up" into "nobody can log in".
 *
 * To implement: pick a door from the block at the top of this file, read config
 * from SMS_CONFIG_PROPERTY, and return true only on a confirmed send - the same
 * contract sendViaResend (Utils.gs) already follows.
 */
function sendSms(phone, text) {
  if (!smsSenderConfigured()) return false;
  if (!phone || !text) return false;
  // No sender implemented yet. Reaching here means SMS_SENDER is set but the
  // integration was never written, so say "did not send" and let the caller
  // fall back to email.
  return false;
}

/**
 * Deliver a one-time code by the recipient's preferred channel, falling back to
 * email whenever the preferred one is unavailable or fails.
 *
 *   recipient  { email, phone, channel }   channel: 'sms' | 'email' | '' (blank = email)
 *   message    { subject, body, smsBody }
 *
 * Returns { sent: bool, channel: 'sms' | 'email' | 'none' } - what ACTUALLY
 * carried it, not what was asked for. No endpoint surfaces this today; callers
 * return the same generic response either way so a delivery failure cannot be
 * used to probe which accounts exist. It is returned anyway so the decision is
 * inspectable from a test and from a future admin view.
 *
 * smsBody is a separate string, not a truncation of body: an SMS is 160
 * characters and the email bodies run to three sentences. Cutting one to fit
 * the other is how a code ends up chopped off the end of a text.
 */
function sendAuthCode(recipient, message) {
  var r = recipient || {};
  var m = message || {};
  var wantsSms = String(r.channel || '').toLowerCase() === 'sms';
  var phone = String(r.phone || '').trim();
  var email = String(r.email || '').trim();

  if (wantsSms && phone && smsSenderConfigured()) {
    var smsText = m.smsBody || m.body;
    if (sendSms(phone, smsText)) return { sent: true, channel: 'sms' };
    // Fall through to email deliberately - see the header block.
  }

  if (email && sendAppEmail(email, m.subject, m.body)) {
    return { sent: true, channel: 'email' };
  }

  return { sent: false, channel: 'none' };
}

/**
 * The channel a row actually gets, as opposed to the one it asked for.
 *
 * Used for user-facing copy ("we emailed you a code" vs "we texted you"), which
 * is why it resolves the same way sendAuthCode does rather than just echoing
 * the stored preference - telling a vendor to check their phone when the code
 * went to their inbox is worse than not saying anything.
 */
function effectiveAuthChannel(row) {
  var o = row || {};
  var wantsSms = String(o.AuthChannel || '').toLowerCase() === 'sms';
  var phone = String(o.Phone || '').trim();
  if (wantsSms && phone && smsSenderConfigured()) return 'sms';
  return 'email';
}
