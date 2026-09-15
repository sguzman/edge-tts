# WIN-NATURAL v2 integration discipline

This branch starts from the browser-verified `stable` runtime and is the clean reintegration line for Windows Natural voices.

For the complete operational and historical record, see the Windows Natural dossier:

- [`win-natural/README.md`](win-natural/README.md) — documentation hub and current state.
- [`win-natural/SETUP.md`](win-natural/SETUP.md) — reproducible machine/browser setup.
- [`win-natural/ARCHITECTURE.md`](win-natural/ARCHITECTURE.md) — backend boundaries and invariants.
- [`win-natural/FORENSICS.md`](win-natural/FORENSICS.md) — full investigation history and falsified hypotheses.
- [`win-natural/TROUBLESHOOTING.md`](win-natural/TROUBLESHOOTING.md) — symptom-driven recovery.
- [`win-natural/VERIFICATION.md`](win-natural/VERIFICATION.md) — gate acceptance matrix and browser evidence.

## Non-negotiable invariant

Existing reading behavior is the control. Every integration stage must preserve the previously working online/direct and Windows-local reader behavior before the next stage begins.

`stable` is never modified during development. The user's primary Edge profile continues loading the stable worktree. A separate Edge profile loads this development worktree.

## Why this branch exists

The first WIN-NATURAL integration mixed native transport, voice discovery, speech-engine inheritance, bootstrap changes, UI classification, playback, and lifecycle work into one large browser-facing change. Automated tests remained green while the actual extension became unusable. The broken line is preserved separately for diagnosis; it is not the base for this reintegration.

## Integration sequence

### Gate 0 — clean baseline

This branch begins at the exact stable commit. Before feature work, load it in the development Edge profile and verify basic reading and Quit. No WIN-NATURAL code is present yet.

**Status: PASSED.** Browser-verified candidate: `81ef5b5d9ede223be82887e768e069337f1458e0` (`Fix Online Natural playback activation`).

### Gate 1 — native host transport only

Add the x64 native host and Native Messaging registration/diagnostics without changing the reader, speech-engine inheritance, toolbar, startup path, or voice selection.

Acceptance:

- Existing reader behavior is unchanged.
- Browser Native Messaging handshake succeeds.
- Browser-side diagnostics enumerate an adapter-backed `Local-*` voice named `Microsoft Aria` with the expected language; the exact token ID is not canonical because it depends on adapter discovery configuration.
- Failure or absence of the native host cannot affect reader startup or playback.

**Status: PASSED.** Browser-accepted Gate 1 candidate includes `acc0b11` (`Finalize Gate 1 Aria discovery`) plus the previously verified Gate 1 transport and diagnostic commits on `development/win-natural-v2`.

Accepted browser behavior:

- Native Messaging connection: PASS.
- Protocol 1 handshake: PASS.
- x64 helper: PASS.
- Edge-launched helper enumerates `Local-NarratorVoices / Microsoft Aria / en-US`.
- `ariaFound: true` with the real SAPI token preserved as `Local-NarratorVoices`.
- Enumeration remains successful under Edge's normal `cmd.exe` native-host launch path with `NativeHostsExecutablesLaunchDirectly` removed.
- Online Natural first playback: PASS.
- Online Natural playback after pause/resume: PASS.
- Windows Legacy/local playback: PASS.
- Stop: PASS.
- Quit: PASS.

Gate 1 also established a machine/deployment requirement: because the Edge-launched native host cannot see the adapter's per-user `NarratorVoicePath` configuration on this machine, the compatible extracted Aria package is exposed through the adapter's documented default filesystem location using a reversible `NarratorVoices` junction. This makes discovery independent of the unavailable HKCU adapter configuration. The exact SAPI token may therefore differ from the earlier direct-probe token (`Local-aria-v2`) and must never be treated as a stable logical identifier.

### Gate 2 — catalog visibility only

Expose WIN-NATURAL voices to the reader catalog and label them explicitly, but do not route normal reading through the new backend until enumeration is browser-verified.

Acceptance:

- `[WIN-NATURAL] Microsoft Aria` appears in the development profile.
- Existing saved voice selection and online/local playback still work.
- Native enumeration is asynchronous and never startup-critical.

**Status: PASSED.** Browser-accepted candidate includes `c5b3675` (`Add Gate 2 Windows Natural catalog visibility`) plus `18faba1` (`Fix Gate 2 voice selection identity`).

Accepted browser behavior:

- Three-way taxonomy appears as Windows Legacy / Windows Natural / Online Natural.
- `[WIN-NATURAL] Microsoft Aria — en-US` appears under Windows Natural and remains disabled/catalog-only.
- Windows Legacy Zira: PASS.
- Windows Legacy Mark: PASS.
- Online Aria: PASS.
- Switching back to Zira after Online playback: PASS.
- Stop: PASS.
- Quit: PASS.
- Asynchronous native catalog arrival no longer overwrites the selected playable voice.

Gate 2 exposed and fixed a real selection bug: name-only voice identity collided when Online Aria and Windows Natural Aria coexisted. The fix introduced backend-aware selection keys and preserved the exact playable voice across catalog refreshes.

A separate Online-catalog limitation was observed during Gate 2 QA: some Online voices such as William failed while Aria succeeded. Diagnostic comparison found no Gate 2 synthesis regression: the direct-audio engine, routing heuristic, and short-name mapping were unchanged from the accepted pre-Gate-2 baseline, and William would have taken the same direct backend before Gate 2. The repository has no pre-Gate-2 browser evidence that William worked. Treat broader Online voice routability as a separate backlog concern rather than expanding Gate 2.

### Gate 3 — isolated WIN-NATURAL playback

Route only an explicitly selected WIN-NATURAL voice through the native backend. Reuse the established direct-audio playback clock where possible; do not rewrite unrelated reader lifecycle code.

Acceptance:

- Aria reads a short webpage selection offline.
- Stop and Quit terminate native playback.
- Existing ONLINE and WIN-LEGACY playback are unchanged.

**Status: PASSED.** Gate 3C was accepted by human browser QA on fresh pages.

Accepted behavior:

- Windows Natural Microsoft Aria speaks through the normal reader.
- Sustained native playback progresses without repeated batches or ghost audio.
- Native Stop, Pause, Resume, Quit, and backend switching work.
- Windows Legacy Zira and Online Aria remain audible and routable.

Deferred to Gate 4/backlog: native startup latency, native word/sentence
highlight synchronization, and precise intra-sentence Pause/Resume position.

### Gate 4 — highlighting and controls

**Status: COMPLETE. Gate 4A, Gate 4B, Gate 4C, and Gate 5 are ACCEPTED. Gate 5
has been promoted after fresh-page human browser QA.**

Gate 4A only captures and transports request-relative native timing metadata.
It does not implement visual highlighting, live rate/volume, pause/resume
changes, or startup-latency optimization. Gate 4B will own timing-to-reader
mapping and highlighting after Gate 4A is accepted.

Gate 4A acceptance evidence: on the reloaded development diagnostics page,
Microsoft Aria enumerated through the background, played audibly, and Stop
worked. Timing reported `YES` with 6 boundaries, first boundary
`char 0, len 7, audio 160.25 ms`, last boundary
`char 39, len 7, audio 2169.333 ms`, and monotonic timing `YES`.

**Gate 4B: ACCEPTED.** Gate 4B maps the accepted timing records to existing
reader segments and emits ordinary reader boundaries from the WIN-NATURAL
audio element's `currentTime`. Canonical `timing[].audioMs` is derived from
the rendered PCM stream; raw SAPI `AudioPosition` remains diagnostic only.
It does not change the highlighter, live controls, pause/resume, or native
startup path.

Gate 4B browser evidence on fresh pages: Microsoft Aria enumerated and played
audibly; diagnostic Stop worked; timing was captured with 6 monotonic
boundaries and source `pcm-stream`; WAV PCM duration and browser
`audio.duration` were both `2823.537 ms`; canonical timing was `261.905 ms`
first and `2361.179 ms` last. In the normal reader, highlighting remained
synchronized at the start and after 15 and 30+ seconds, sentence highlighting
tracked the audible sentence, and Stop halted highlight movement immediately.

**Gate 4C: ACCEPTED.** WIN-NATURAL rate changes
use the persistent WAV element's browser `playbackRate`; they do not alter
SAPI synthesis or canonical PCM timing. WIN-NATURAL volume changes use a
persistent `MediaElementAudioSourceNode -> GainNode -> destination` graph
when Web Audio is available, supporting the existing 0–200% gain range.
The graph is created once per persistent native audio element and reused
across chunks. Online and Windows Legacy controls retain their existing
routing.

Gate 4C browser evidence on fresh pages for correction candidate
`f5cbda3a145098be50ffd0c2db17945d514f90fb`: live rate changes from 1x to
approximately 2x and back to approximately 0.7x passed without restart,
resynthesis, gaps, overlap, or highlighting drift. Live volume changes from
100% to 0%, back to 100%, and through 150–200% gain passed without restart,
gaps, pops, duplicates, or instability. Stop/Play remained functional.
Quit followed by same-tab restart passed twice consecutively after final
engine disposal was added.

Gate 4C lifecycle architecture: Stop/cancel is a reusable reset; Quit is
final dispose. Final disposal invalidates generation and tears down old audio,
object URLs, animation frames, handlers, Web Audio nodes/context, and
inherited direct-audio resources, allowing the resident content-script
bootstrap to create a fresh ReaderApp in the same tab.

Known deferred UX limitations: WIN-NATURAL startup/synthesis latency remains
high for a local/offline voice, and Pause -> Resume restarts the current
sentence rather than preserving an exact intra-sentence media position. These
are backlog items and are not implemented in Gate 4C.

Gate 4B acceptance:

- Highlighting follows SAPI timing data.
- Highlighting follows the actual PCM/browser media timeline.
- Existing Stop/Quit teardown remains intact.

Gate 4 overall is complete after Gate 4C. The WIN-NATURAL startup/synthesis
latency optimization is accepted. Gate 5 is accepted and promoted.

### Gate 5 — promotion candidate

**Status: ACCEPTED AND PROMOTED.** Accepted candidate
`360460a99a0b52cc5d45fa3c406c84f881f9752c` was compared against rollback point
`c089d08ece6009592faa2fdf4306e4ce873e4ea8`; their pre-promotion merge-base
was the stable SHA. Gate 5 passed fresh-page human QA and was fast-forwarded
to stable after the required checks.

The candidate contains only the intended WIN-NATURAL integration, diagnostics,
native helper/setup, tests, latency optimization, and documentation changes.
The exact final browser matrix is recorded in `docs/win-natural/VERIFICATION.md`.
Only after that exact candidate passes human QA may it be considered for stable
promotion under `docs/STABILITY.md`.

The current Gate 5 correction is focused on a development-only Online Natural
timeout observed after the WebSocket had opened and delivered metadata and large
audio frames. The candidate removes per-frame console diagnostics from the
direct MP3 hot path while retaining O(1) phase logs and one `turn.end` summary.
The 12-second connection timeout is unchanged; this correction does not
redesign the transport or alter WIN-NATURAL.

Gate 5 human acceptance covered Windows Legacy Zira, Online Aria and their
routing/switching; fast and synchronized WIN-NATURAL Aria playback; live rate
and volume; Stop -> Play; Quit -> same-tab restart; WIN-NATURAL/Online
switching; and no chunk gaps, ghost audio, or overlap. Stable promotion
preserves `c089d08ece6009592faa2fdf4306e4ce873e4ea8` as the rollback point.

## Architectural constraints

- Do not make WIN-NATURAL discovery part of startup readiness.
- Do not alter bootstrap/session lifecycle merely to add a voice backend.
- Do not replace the working ONLINE direct MP3 transport.
- Do not use the UI/render path for heavy or blocking native work.
- Do not bundle Microsoft voice packages.
- Keep the helper persistent after first use so the embedded model remains warm.
- Keep Native Messaging requests bounded and explicitly correlated by request/session ID.
- Treat extension IDs as profile/worktree-specific deployment data. The native-host manifest must authorize the development extension ID used by the development Edge profile.

## Gate 0 accepted state

Manual testing in the dedicated development Edge profile established the following on commit `81ef5b5d9ede223be82887e768e069337f1458e0`:

- The HUD starts normally.
- Online Natural first playback: PASS.
- Online Natural second playback: PASS.
- Stop: PASS.
- Quit: PASS.
- Windows Legacy/local playback: PASS.
- WIN-NATURAL voices remain intentionally absent at Gate 0 because Native Messaging has not yet been reintegrated.
- The current baseline UI still uses the older two-class `Local Windows` / `Natural / Online` taxonomy. The target taxonomy remains `Windows Legacy` / `Windows Natural` / `Online Natural`; restore that in the catalog-visibility stage rather than mixing it into transport work.

The development profile showed substantial Online Natural startup latency after pause/stop. This is recorded as a performance concern, not a Gate 0 correctness failure. Do not destabilize the verified direct-online path while integrating WIN-NATURAL.

## Promotion rule

Unit tests, syntax checks, native-helper tests, or agent completion reports do not establish browser correctness. A stage advances only after its required browser behavior has actually been observed in the development Edge profile.
