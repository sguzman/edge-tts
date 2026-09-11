# Stability discipline

This repository has two operational roles:

- `stable` is the load-bearing runtime branch. It must remain a previously browser-verified working build.
- `main` is the development/integration branch. It may contain unfinished or regressed work and must not be treated as the user's reading runtime until promoted.

## Runtime rule

The browser should normally load the unpacked extension from a working tree checked out to `stable`, not from the development working tree.

Development should occur in a separate Git worktree so experimental changes cannot contaminate the runtime files Edge is actively loading.

## Promotion rule

`stable` advances only after all of the following are true:

1. Automated tests/checks pass.
2. The exact candidate commit is loaded in Edge and manually exercised on a real webpage.
3. Basic reading works.
4. Quit works.
5. Existing voice backends still work.
6. Any newly changed backend is manually exercised.
7. The user explicitly accepts the candidate as working.

Unit tests, native-helper tests, source inspection, or Codex completion reports are not sufficient to promote a browser-facing change.

## Failure rule

When `main` regresses, fix forward on `main`. Do not move `stable` until the repair itself has passed the promotion rule. The load-bearing runtime remains available throughout development.

## Current recovery point

The initial `stable` branch was created at commit `c089d08ece6009592faa2fdf4306e4ce873e4ea8`, the last known working pre-WIN-NATURAL integration state.

A snapshot of the broken WIN-NATURAL development state is preserved separately so investigation can continue without modifying the stable runtime.
