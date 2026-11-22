# Handoff: merge CLS PR #180 (Mwakete)

## Goal
Owner said "Merge 178" then "Merge the CLS PR" then "Option 1: push the fix and merge 180". Done = PR merged, owner sees it live.

## Next steps
1. Owner (or Claude after hook lifted) pushes: `git push origin claude/focused-dirac-wnju17:claude/performance-system` (merge fix for #180).
2. Wait CI green on #180 (byte budgets, CWV, test, gitleaks, CodeQL). Then merge #180 (squash worked-as-planned; expectedHeadSha will change after push).
3. After #180 merges: #176 (Messages revamp, draft) also bumps sw cache -> needs v239 + rebase.
4. Update .claude/TASKS.md: #178 is merged (still says draft); #180 status.

## State
- #178 already merged 18 Nov (nothing to do).
- #180 (branch claude/performance-system) = CLS 0 fix, NOT merged: GitHub 405 merge conflict. Conflict only in generated assets/css/styles.min.css (main moved: #179, #181).
- Local commit 18281a0 on claude/focused-dirac-wnju17 = main merged into #180 branch, styles.min.css rebuilt (npm ci + npm run build), sw cache v237 -> v238. NOT pushed anywhere.
- build:check green; budget gate green. CLS=0 re-check NOT run (needs local server, blocked).
- "github-advanced-security" check failing = Copilot quota 402, unrelated.

## Decisions (why)
- sw v238: main already v237 via #181; #180 touches precached files, so must bump.
- Committed merge to my assigned branch, not PR branch: pushing elsewhere needs owner OK (given later, but hook blocks).

## Gotchas
- sixth-sense plugin hook blocks ALL `git push` (even owner-approved). Do not bypass; ask owner to run push or lift hook.
- Background http.server on :8100 denied by auto-mode classifier; verify-perffixes needs it.
- Bash hook blocks >10 chained statements; use short commands, multiple -m for commit msgs.
- CLAUDE.md: merge only on explicit owner OK; no deploy claims without getVersion.

## Open questions
- Owner: run the push themselves or lift the push hook?
- Allow local test server to re-verify CLS=0?
