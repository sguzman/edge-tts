# WIN-NATURAL v2 integration discipline

This branch starts from the browser-verified `stable` runtime and is the clean reintegration line for Windows Natural voices.

## Non-negotiable invariant

Existing reading behavior is the control. Every integration stage must preserve the previously working online/direct and Windows-local reader behavior before the next stage begins.

`stable` is never modified during development. The user's primary Edge profile continues loading the stable worktree. A separate Edge profile loads this development worktree.

## Why this branch exists

The first WIN-NATURAL integration mixed native transport, voice discovery, speech-engine inheritance, bootstrap changes, UI classification, playback, and lifecycle work into one large browser-facing change. Automated tests remained green while the actual extension became unusable. The broken line is preserved separately for diagnosis; it is not the base for this reintegration.

## Integration sequence

### Gate 0 — clean baseline

This branch begins at the exact stable commit. Before feature work, load it in the development Edge profile and verify basic reading and Quit. No WIN-NATURAL code is present yet.

### Gate 1 — native host transport only

Add the x64 native host and Native Messaging registration/diagnostics without changing the reader, speech-engine inheritance, toolbar, startup path, or voice selection.

Acceptance:

- Existing reader behavior is unchanged.
- Browser Native Messaging handshake succeeds.
- Browser-side diagnostics enumerate `Microsoft Aria / Local-aria-v2`.
- Failure or absence of the native host cannot affect reader startup or playback.

### Gate 2 — catalog visibility only

Expose WIN-NATURAL voices to the reader catalog and label them explicitly, but do not route normal reading through the new backend until enumeration is browser-verified.

Acceptance:

- `[WIN-NATURAL] Microsoft Aria` appears in the development profile.
- Existing saved voice selection and online/local playback still work.
- Native enumeration is asynchronous and never startup-critical.

### Gate 3 — isolated WIN-NATURAL playback

Route only an explicitly selected WIN-NATURAL voice through the native backend. Reuse the established direct-audio playback clock where possible; do not rewrite unrelated reader lifecycle code.

Acceptance:

- Aria reads a short webpage selection offline.
- Stop and Quit terminate native playback.
- Existing ONLINE and WIN-LEGACY playback are unchanged.

### Gate 4 — highlighting and controls

Add word-timing synchronization, live playback rate, and volume without resynthesis.

Acceptance:

- Highlighting follows SAPI timing data.
- Speed and volume changes are live.
- Consecutive requests reuse the persistent helper.
- No orphan audio remains after Stop/Quit.

### Gate 5 — promotion candidate

Only after browser QA of the exact candidate commit may it be considered for `stable` promotion under `docs/STABILITY.md`.

## Architectural constraints

- Do not make WIN-NATURAL discovery part of startup readiness.
- Do not alter bootstrap/session lifecycle merely to add a voice backend.
- Do not replace the working ONLINE direct MP3 transport.
- Do not use the UI/render path for heavy or blocking native work.
- Do not bundle Microsoft voice packages.
- Keep the helper persistent after first use so the embedded model remains warm.
- Keep Native Messaging requests bounded and explicitly correlated by request/session ID.
- Treat extension IDs as profile/worktree-specific deployment data. The native-host manifest must authorize the development extension ID used by the development Edge profile.

## Gate 0 observed state

Manual testing in the dedicated development Edge profile established the following:

- The HUD starts normally.
- Explicitly selected Windows legacy/local voices play successfully.
- The reader/audio-ownership/background path is therefore functioning for the local backend.
- Online Natural voices are visible but the direct online backend does not currently produce playback in the fresh development profile.
- WIN-NATURAL voices are intentionally absent at Gate 0 because the clean reintegration branch does not yet contain Native Messaging integration.
- The current baseline UI still uses the older two-class `Local Windows` / `Natural / Online` taxonomy. The target taxonomy remains `Windows Legacy` / `Windows Natural` / `Online Natural`; restore that only after the online baseline playback blocker is resolved.

Gate 0 is **not complete** until Online Natural playback works in the development profile. Do not begin WIN-NATURAL integration before that blocker is resolved.

## Promotion rule

Unit tests, syntax checks, native-helper tests, or agent completion reports do not establish browser correctness. A stage advances only after its required browser behavior has actually been observed in the development Edge profile.
