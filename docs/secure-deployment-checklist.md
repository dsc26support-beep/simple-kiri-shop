# Secure deployment checklist — Mwakete

Date: 2026-11-17. The security-focused companion to [`DEPLOY.md`](../DEPLOY.md).
`DEPLOY.md` is the mechanical "how to ship a backend change"; this page is the
"did we ship it safely" gate. Run through it for any release; most of it is
once-off GitHub/Google settings you confirm, not per-deploy work.

## A. One-time GitHub settings (owner — do these once, then just confirm)

These are repository **Settings**, not code, so Claude cannot set them — the
owner does, in the repo's **Settings → Code security** (and **Branches**):

- [ ] **Secret scanning: ON.** Catches credentials committed to the repo. Free
      for public repositories. (CI also runs the `secret-scan` / gitleaks
      workflow on every PR as a backstop.)
- [ ] **Push protection: ON.** Blocks a push that contains a detected secret
      *before* it lands — the strongest form.
- [ ] **CodeQL / code scanning: present.** This repo ships its own
      `.github/workflows/codeql.yml`, so leave GitHub's "default setup" **off**
      (two CodeQL setups conflict); results appear in the **Security** tab.
- [ ] **Private vulnerability reporting: ON.** Gives researchers the private
      channel `SECURITY.md` points to.
- [ ] **Dependabot alerts: ON.** The site ships no runtime dependencies, but the
      two dev build tools (terser, clean-css) and any Actions still get alerts.
- [ ] **Branch protection on `main`:** require a pull request, and require the
      status checks to pass before merge (Performance budgets, SMS backend tests
      where they apply, CodeQL, Secret scan). Prevents an unreviewed or
      red-CI change reaching the live site.
- [ ] **GitHub Pages → Enforce HTTPS: ON** (already confirmed in the audit).
- [ ] **2-step verification ON** for the GitHub account that owns the repo and
      the Google account that owns the Apps Script project + Sheet.

## B. Before every deploy

- [ ] Work on a branch and a PR, never commit straight to `main`.
- [ ] `npm run build` ran and the result is committed; **`npm run build:check`
      is green** (includes the CSP freshness guard from Stage 2).
- [ ] The relevant test suites pass (see `tests/README.md`); for a backend change,
      the gas-harness suites and `tests/test-security-stage3.js` (access control).
- [ ] CI on the PR is green: Performance budgets, SMS backend tests (if
      `apps-script/**` changed), **CodeQL**, **Secret scan**.
- [ ] No secret, key, token or password anywhere in the diff. Secrets belong in
      Apps Script **Script Properties** only — never in `*.js`, `*.gs`, `*.html`
      or a workflow file. (`config.js` may hold only the **public** Apps Script
      URL and Google OAuth **client ID**.)
- [ ] If a precached file changed, the service-worker `CACHE` is bumped (`sw.js`).
- [ ] **Take a fresh Sheet backup** before any backend deploy
      (`docs/backup-restore.md`).

## C. The deploy itself

- [ ] **Frontend only** (HTML/CSS/JS): nothing to do — merging the PR ships it
      via GitHub Pages. (Stage 2 CSP, Stage 4 docs/workflows are all here.)
- [ ] **Backend** (`apps-script/*.gs` changed): follow `DEPLOY.md` — paste only
      the changed `.gs` files, mind new-file and manifest/scope notes, and if
      `APP_VERSION` changed, that is the version you will verify next.
- [ ] Never paste a secret into the editor; set those as Script Properties.

## D. After every deploy — verify, do not assume

Per `CLAUDE.md`, a backend deploy is **not** done until confirmed from outside:

- [ ] **`?action=getVersion`** returns the expected `APP_VERSION`
      (e.g. the pending Stage 1 deploy expects `secure1-2026-11-16`). If it still
      shows the old version, the paste or the "Deploy → Manage deployments → edit
      → new version" step did not take.
- [ ] **`checkSetup`** (the backend self-check) is clean — no missing tab, column,
      script file, or scope.
- [ ] A real check on a phone: sign in (Google + Facebook if enabled), open a
      store and a product, add to cart, and — for a returning visitor — confirm
      the service worker picked up the new version. Console shows **no CSP
      violation**.
- [ ] Watch Apps Script **Executions** for new errors for a little while.

## E. Record it

- [ ] Note what shipped and the confirmed `getVersion` in `.claude/TASKS.md`
      (and the relevant doc), so the next session knows the live state.

---

### Current known pending deploy

As of 2026-11-17, **Stage 1's backend change is still awaiting the owner's manual
Apps Script deploy** — target `getVersion = secure1-2026-11-16` (`APP_VERSION`
in `apps-script/Code.gs` is already set to it in `main`; it just needs pasting +
a new deployment version). Stages 2 and 4 are frontend/repo-only and need no
backend deploy.
