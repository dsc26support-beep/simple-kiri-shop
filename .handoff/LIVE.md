# Handoff: store.html CLS -> 0 (draft PR #183)

## Goal
Owner chain this session: fix PR #180 merge conflict + merge; verify-perf / verify-perffixes on main; measure homepage CLS; measure store.html CLS; fix store.html CLS to zero.

## Next steps
1. Owner reviews draft PR #183 (dsc26support-beep/simple-kiri-shop, branch claude/store-cls-zero). Merge ONLY on explicit "Merge 183" (CLAUDE.md: no merge without approval).
2. After merge: set TASKS.md line to [merged #183]; frontend-only, no backend deploy.
3. Optional follow-ups (not started): same search-submit collapse shift likely on other pages with .search-box (home, search, store list); real-device CLS check.

## State
- #180 merged to main (squash ff18564). Conflict was only generated styles.min.css -> merged main in, ran npm run build; sw cache bumped v238 (main already v237).
- main measured: index CLS 0.0000 x3 (control bd1fc92: 0.0249); store.html 0.0134 before.
- #183: store.html + styles.css(+min) + sw.js v238->v239 + .claude/TASKS.md. store CLS 0.0000, 0 shifts x3.
- Tests: verify-perffixes 27/27; verify-perf 27/28 (only known offline-nav fail, same on main); build:check green. CI on #183 not yet seen.
- NOT verified: real backend, real devices, desktop width, stores with many photos/logo.

## Decisions (why)
- Cause 1: Products/Photos label gained block .sp-act-num count line on data load (+~15px) -> put empty placeholder in markup (no JS change).
- Stretch+center #sp-count-* labels: mock has 1 photo so "Photos"->"Photo" resized box 3px.
- Cause 2: search-submit animated 44px->0 when JS added .is-empty post-load -> form starts with is-empty.
- Squash-merged #180 only after all 6 CI checks green; user asked "merge it" up front.

## Gotchas
- Bash hook: max 10 statements/500 chars, no inline python; use Edit tool. PostToolUse formatter reformatted sw.js (229-line diff) -> revert and use sed for 1-char bumps.
- Local servers needed: verify-perf port 8099, verify-perffixes port 8100 (python3 -m http.server --bind 127.0.0.1, run_in_background). npm ci first.
- Shallow clone: fetch with explicit refspec to create origin/* refs; stop hook falsely says unpushed (check git ls-remote).
- Measure scripts: scratchpad home-cls.js, store-cls.js (may vanish).

## Open questions
- Merge #183? Apply same is-empty fix to other pages' search boxes?
