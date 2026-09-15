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

The unpacked extension ID is profile/worktree-specific. Stable and development
use different host names, per-channel manifests, payload directories, and
registry keys. The runtime selects the host from its extension ID and fails
closed for unknown IDs. Each installer invocation requires an explicit channel
and authorizes only that channel's origin; it never merges origins into a
shared manifest. A development install is therefore disposable and cannot
overwrite or unregister stable state.

After a candidate is promoted to the stable worktree, the human must read the
stable extension's ID from `edge://extensions` in the stable Edge profile and
run the installer with `-Channel Stable` from the promoted stable checkout.
This machine registration remains separate from repository promotion.

Do not perform that machine registration or stable-branch move as part of
Gate 5 candidate preparation.
