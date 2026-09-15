# Stability discipline

`stable` is the load-bearing, browser-verified runtime. The
`development/win-natural-v2` branch and worktree are for integration and must
not mutate the stable worktree during development.

Stable promotion rules:

- the exact candidate SHA must be loaded in Edge and accepted by human browser
  QA on a real webpage;
- `npm test`, `npm run check`, and `git diff --check` must pass, but automated
  checks are necessary and not sufficient;
- existing backends and any newly changed backend must be exercised;
- accepted limitations must remain documented rather than silently forgotten;
- the previous stable SHA must remain identifiable as the rollback point.

## Native Messaging deployment

The unpacked extension ID is profile/worktree-specific. The development host
registration authorizes the development extension origin only. After a
candidate is promoted to the stable worktree, the human must read the stable
extension's ID from `edge://extensions` in the stable Edge profile and run the
native-host installer from the promoted stable checkout with that ID. This
updates the current-user host manifest's `allowed_origins`; it does not change
the voice package or the stable worktree automatically.

Do not perform that machine registration or stable-branch move as part of
Gate 5 candidate preparation.
