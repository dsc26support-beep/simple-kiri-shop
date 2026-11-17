# Security policy

Mwakete ([mwakete.com](https://mwakete.com)) is a small marketplace for Kiribati.
We take security seriously and welcome good-faith reports from researchers.

## Supported version

Only the **live site** is supported — mwakete.com and its Google Apps Script
backend, always at the latest deployed version. There are no released branches
to patch; a fix ships by deploying the site and (when the backend changes) the
Apps Script project.

## Reporting a vulnerability

**Please report privately — do not open a public GitHub issue, pull request, or
post details anywhere public until we have confirmed a fix.**

Preferred channel: **GitHub private vulnerability reporting**
→ the repository's **Security** tab → **Report a vulnerability**
(<https://github.com/dsc26support-beep/simple-kiri-shop/security/advisories/new>).
It is private, goes straight to the maintainers, and needs no email address.

If you cannot use that channel, open a public issue that says only *"security
report — please enable a private channel"* with **no technical detail**, and we
will open a private advisory to continue.

Please include, as far as you can:

- what the issue is and why it matters (the impact);
- the exact steps or a small proof of concept to reproduce it;
- the page, URL, or backend action involved;
- any accounts, IDs, or sample data you used (do not use other people's data).

## What to expect

We are a very small team, so timelines are best-effort, not contractual:

- **Acknowledgement:** within about 3 business days.
- **First assessment** (severity, whether we can reproduce): within about 7 days.
- **Fix:** critical issues as fast as we safely can; others on a schedule we will
  share with you. We will tell you when a fix has shipped, and credit you if you
  would like.

There is **no paid bug bounty** at this time.

## Scope

**In scope:** mwakete.com, the seller/admin pages under `/owner/` and `/pos/`,
and the Apps Script backend behaviour reachable from them.

**Out of scope / please do not:**

- Denial-of-service or volumetric/load testing against the live backend (it
  runs on a shared Google quota — testing it degrades service for real users).
- Automated scanning that creates accounts, orders, messages, or uploads in
  bulk on the production site.
- Social engineering, phishing, or physical attacks against the team or users.
- Findings in third-party services we rely on (Google / Apps Script, Cloudinary,
  Facebook, GitHub Pages) — report those to the respective vendor.
- Reports that are only "best-practice" output from an automated tool with no
  demonstrated impact (e.g. a missing header we already document as a known
  platform limit — see `docs/security-audit-2026-11.md`).

## Safe harbour

We will not pursue or support legal action against researchers who act in good
faith, follow this policy, avoid privacy violations and service disruption, and
give us reasonable time to fix an issue before any disclosure. If you are unsure
whether an action is allowed, ask first through the private channel above.
