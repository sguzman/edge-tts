# Windows Natural verification matrix

This file records what constitutes acceptance for each integration gate and which behaviors have actually been observed in Edge.

The governing rule is simple:

> automated tests can reject a candidate, but only browser/runtime observation can accept a browser-facing gate.

## Environment model

Use two physically separate worktrees and Edge profiles:

```text
stable worktree       -> primary/self-consumption Edge profile
development worktree  -> development Edge profile
```

Never infer development success from the stable profile or vice versa.

## Browser candidate QA control: fresh page required

After changing, reverting, or reloading the unpacked extension, perform browser
acceptance only on a newly opened page or a fully reloaded page that has not
retained a reader runtime from another candidate. Do not use a tab that
previously hosted a different injected build as evidence for the current source
tree.

The injected page runtime and extension namespace can remain resident long enough
to make an existing tab untrustworthy during extension-reload development. The
reader bootstrap also has an existing-runtime sentinel/readiness optimization to
avoid duplicate injection. Consequently, stale page state can masquerade as
current-candidate behavior even after the repository and unpacked extension have
been reverted or reloaded.

Required procedure after every candidate change or revert:

1. Reload the unpacked extension.
2. Open a genuinely new webpage/tab, or fully reload a page that did not host the
   previous candidate runtime.
3. Run the acceptance checklist there.
4. Discard any contradictory result from a previously injected tab until it has
   been replaced by a fresh page.

This control condition was confirmed during Gate 3 recovery: the reverted tree
matched the accepted Gate 2 source exactly, yet an old Gate 3-injected tab still
failed. On a new page after extension reload, Windows Legacy Zira and Online Aria
passed again.

## Gate 0 — known-good reader baseline

### Purpose

Prove that the development worktree can run the existing reader before any Windows Natural integration is added.

### Required manual checks

```text
HUD opens once
Online Natural first playback
Online Natural second playback
Stop
Quit
Windows Legacy playback
```

### Accepted result

Browser-verified on the clean reintegration line:

```text
Online Natural first playback: PASS
Online Natural second playback: PASS
Stop: PASS
Quit: PASS
Windows Legacy playback: PASS
```

The accepted Gate 0 fix addressed fresh-profile media user activation for the direct Online Natural audio element.

### Not required

Windows Natural voices are intentionally absent.

## Gate 1 — Native Messaging transport + local voice enumeration

### Purpose

Prove that Edge can communicate with a persistent x64 helper and that the helper can enumerate the compatible adapter-backed local Aria voice without changing reader startup or normal speech routing.

### Required transport checks

```text
Native Messaging connection succeeds
protocol == 1
architecture == x64
request/response path is bounded
helper failure is isolated from reader
```

### Required voice check

The logical voice must be:

```text
adapter-backed ID: Local-*
name: Microsoft Aria
language: en-US
```

The actual token ID must be preserved rather than rewritten.

### Browser diagnostic

From the development extension service-worker DevTools console:

```javascript
globalThis.EdgeTtsNativeMessaging
  .createTransport()
  .diagnostics()
  .then(console.log)
  .catch(console.error)
```

### Accepted Gate 1 result

After the registry-independent `NarratorVoices` junction was installed and the temporary Edge direct-launch policy was removed:

```text
connected: true
handshake.protocol: 1
handshake.architecture: x64
voices:
  - id: Local-NarratorVoices
    name: Microsoft Aria
    lang: en-US
ariaFound: true
ariaVoice.id: Local-NarratorVoices
```

The helper's parent process returned to `cmd.exe`, proving that the final working setup does not depend on the temporary `NativeHostsExecutablesLaunchDirectly` policy.

### Gate 1 regression checks

Manually verified after final enumeration success:

```text
Windows Legacy playback: PASS
Online Natural playback: PASS
Online Natural after pause: PASS
Stop: PASS
Quit: PASS
```

### Gate 1 causal evidence

The following intermediate facts were also established:

```text
same user/SID direct vs Edge launch
same x64 architecture
same medium integrity
not AppContainer
not restricted
registry virtualization disabled
Edge helper could not see adapter HKCU key
changing cmd.exe vs direct launch did not fix it
filesystem NarratorVoices default path did fix it
fix remained after temporary policy removal
```

## Gate 2 — catalog visibility only

### Purpose

Expose Windows Natural voices in the normal reader catalog and restore the three-way voice taxonomy without routing reading through the native backend yet.

### Required manual checks

```text
Windows Natural category exists
Microsoft Aria appears in that category
Windows Legacy remains distinct
Online Natural remains distinct
saved/selected existing voices do not migrate incorrectly
reader startup remains non-blocking if native host is missing or slow
Online Natural playback still works
Windows Legacy playback still works
Stop works
Quit works
```

### Explicit non-goal

Selecting Aria does not yet need to produce Windows Natural speech unless Gate 3 routing is intentionally added. Gate 2 is catalog visibility only.

### Status

**PASSED.** Browser-accepted implementation is `c5b3675` plus the selection-identity fix `18faba1`.

### Gate 2 implementation notes

The catalog representation preserves the runtime SAPI token and marks the
entry as catalog-only:

```text
__edgeTtsSource: win-natural
nativeVoiceId: Local-NarratorVoices
catalogOnly: true
```

The content side requests native voices asynchronously after construction and
notifies the existing voice-change listeners when the result arrives. The
background side handles the request in the existing single runtime dispatcher;
native absence, timeout, or malformed results resolve to an empty list.

The three UI labels are `[WIN-LEGACY]`, `[WIN-NATURAL]`, and `[ONLINE]` under
the filters `Windows Legacy`, `Windows Natural`, and `Online Natural`.
Windows Natural options are disabled during Gate 2. Reader selection filters
catalog-only voices and rejects them again in the local speech engine, so a
stale saved `Microsoft Aria` setting cannot route through an existing backend.

Gate 2 initially failed browser QA because toolbar/persistence identity used
`voice.name`. Online Aria and Windows Natural Aria therefore collided, and
asynchronous catalog refresh could replace a selected Windows Legacy voice.
The corrective commit `18faba1` introduced backend-aware selection keys,
persisted `voiceKey`, preserved an already selected playable voice across
refreshes, and kept catalog-only voices excluded from playback.

### Accepted browser evidence

```text
Three-way filter: PASS
[WIN-NATURAL] Microsoft Aria visible: PASS
[WIN-NATURAL] Microsoft Aria disabled/catalog-only: PASS
Windows Legacy Zira playback: PASS
Windows Legacy Mark playback: PASS
Online Aria playback: PASS
Switch Online -> Zira and retain Zira: PASS
Stop: PASS
Quit: PASS
```

### Separate Online-catalog observation

During Gate 2 QA, some other Online voices such as William failed while Aria
worked. Diagnostic comparison found no Gate 2 synthesis regression:

```text
direct-audio-engine.js unchanged from pre-Gate-2 baseline
reliable-speech-engine.js unchanged from pre-Gate-2 baseline
William satisfies the same existing isDirectVoice() heuristic
William maps to en-US-WilliamNeural via the unchanged mapper
pre-Gate-2 manual QA did not establish William playback
```

The UI's `[ONLINE]` classification is broader than the direct backend's notion
of known routability, so broader Online voice capability remains a separate
backlog concern. Do not expand Gate 2 to rewrite the Online synthesis backend.

## Gate 3A — isolated diagnostics-page native playback

### Purpose

Prove the complete Windows Natural synthesis/playback pipeline without involving
ReaderApp or normal-page lifecycle:

```text
diagnostic button
  -> Native Messaging
  -> SAPI Aria synthesis
  -> multipart WAV
  -> diagnostics-page HTMLAudioElement
  -> audible sound
```

The page is opened directly as an extension-origin diagnostics page. It owns its
audio element, object URL, stop state, and generation invalidation. It does not
use `src/background.js`, ReaderApp audio ownership, `chrome.tts`, or normal
reader injection. WIN-NATURAL remains catalog-only/disabled in normal pages.

### Required manual checks

```text
diagnostic page connects to the x64 helper
Local-* Microsoft Aria token is displayed
Speak Aria diagnostic produces audible speech
Stop immediately silences the diagnostic page
late synthesis response cannot restart playback after Stop
```

### Status

**PASSED.** Human browser acceptance confirmed the isolated page connects with
protocol 1/x64, enumerates `Local-NarratorVoices / Microsoft Aria`, produces
audible local Aria speech, and stops immediately. A fresh normal reader page
also preserved audible Windows Legacy Zira and Online Aria playback while
WIN-NATURAL remained visible but disabled/catalog-only.

Online William remained non-audible, consistent with the previously known
Online voice limitation and not attributable to Gate 3A.

## Gate 3B — background-owned native synthesis outside ReaderApp

The Gate 3B candidate moves the diagnostic page's Native Messaging authority
into the service worker:

```text
diagnostics page
  -> chrome.runtime messaging
  -> one lazily cached background transport
  -> Native Messaging helper
  -> bounded multipart WAV response
  -> diagnostics-page HTMLAudioElement
```

The diagnostics page no longer loads or calls `connectNative()`. The background
reuses a healthy transport, clears its cache on disconnect or request failure,
and can reconnect on a later diagnostics request. Extension-page synthesis does
not require `sender.tab.id`. ReaderApp and all normal reader playback remain
outside this gate.

**PASSED.** Human browser acceptance was completed on fresh pages after
reloading the unpacked extension. The diagnostics page reported
`Connected via background — protocol 1, x64`, enumerated
`Local-NarratorVoices / Microsoft Aria`, produced audible local Aria speech,
and Stop worked. A fresh normal reader page preserved audible Windows Legacy
Zira and Online Aria while WIN-NATURAL remained visible but
disabled/catalog-only. Gate 3C remains the future normal-reader WIN-NATURAL
integration gate.

## Gate 3C — minimal normal-reader WIN-NATURAL routing

The Gate 3C candidate makes the enumerated WIN-NATURAL voice selectable and
routes it through the existing `LocalTtsSpeechEngine` rather than adding
another speech-engine wrapper:

```text
LocalTtsSpeechEngine
  -> chrome.runtime.sendMessage
  -> background-owned Native Messaging transport
  -> x64 helper / SAPI
  -> bounded WAV response
  -> page-owned HTMLAudioElement
```

Native playback has separate session/audio/object-URL state from Chrome TTS and
the Online direct MP3 backend. Switching backends clears the native state
before delegating to the existing route. Native Stop, Pause/cancel, Quit,
preemption, and voice changes invalidate generations and clean up audio and
object URLs. The existing reader owns audio leasing and normal batch
progression.

Gate 3C deliberately does not provide native word boundaries, live native rate
control, or warm-latency optimization. The native session explicitly owns
completion without boundaries, so the ReliableReader and failsafe liveness
watchdogs do not retry healthy native audio; those watchdogs remain active for
the backends they protect. Gate 4 owns timing, highlighting, and live controls.

**ACCEPTED.** Fresh-page human browser QA confirmed Windows Legacy Zira,
Online Aria, and WIN-NATURAL Microsoft Aria playback; sustained native
progression; native Stop/Pause/Resume/Quit; and clean switching among all three
backends without repeated batches or ghost audio.

Deferred limitations, not Gate 3C blockers: native startup/synthesis latency,
native word/sentence highlight synchronization, and Pause/Resume restarting at
the current sentence instead of preserving an intra-sentence audio position.

## Gate 4 — timing, highlighting, live controls, warm reuse

**COMPLETE — Gate 4A, Gate 4B, Gate 4C, and Gate 5 ACCEPTED.** Gate 4A captures
request-relative SAPI `SpeakProgress` records and transports them with the
completed WAV. It stops before visual mapping/highlighting and live control
changes.

Human browser evidence on candidate `8914d4a75a5e1f52e50d95e079206a428878d9f3`
after reloading the unpacked development extension:

1. Microsoft Aria enumerated through the background: PASS;
2. Aria playback was audible: PASS;
3. timing captured: YES;
4. boundary count: 6;
5. first boundary: `char 0, len 7, audio 160.25 ms`;
6. last boundary: `char 39, len 7, audio 2169.333 ms`;
7. monotonic timing: YES;
8. Stop stopped audio: PASS.

The accepted Gate 4A transport contract remains `{ charIndex, charLength,
audioMs }`, with character offsets relative to the exact synthesis text and
raw `audioMs` originating from SAPI milliseconds. Gate 4A does not implement
highlighting, live rate/volume, pause/resume changes, or startup-latency
optimization.

### Gate 4B — media-clock highlighting (accepted)

**ACCEPTED.** SAPI timing is boundary evidence only; the
WIN-NATURAL `HTMLAudioElement.currentTime` is the playback clock. Existing
reader segments and the existing Highlighter remain presentation authority.
The accepted candidate maps timing through `payload.starts` and emits existing
`onBoundary` callbacks without changing Zira or Online routing.

Gate 4B timing investigation found that the SAPI `AudioPosition` clock was
not the rendered-media clock. Fresh diagnostics measured a 22050 Hz WAV with
PCM duration `2823.537 ms`, exactly matching browser `audio.duration`; the
first boundary was `160.25 ms` SAPI versus `261.905 ms` PCM, and the last was
`2169.333 ms` SAPI versus `2361.179 ms` PCM. The correction candidate now
uses validated PCM-stream timestamps derived from the WAV data offset and
byte rate for canonical `timing[].audioMs`; raw SAPI values remain diagnostic
only. The media-clock scheduler and segment mapping are unchanged.

Human browser acceptance on fresh pages for candidate
`eb9077122b8d18f85bf8dbd092647eeab0b56749`:

1. Microsoft Aria enumerated, played audibly, and diagnostic Stop passed;
2. timing captured with 6 monotonic boundaries and source `pcm-stream`;
3. WAV sample rate `22050 Hz`, byte rate `44100 B/s`, PCM duration
   `2823.537 ms`, and browser `audio.duration` `2823.537 ms`;
4. canonical first/last timing `261.905 ms` / `2361.179 ms` PCM, versus raw
   SAPI first/last `160.25 ms` / `2169.333 ms`;
5. normal-reader WIN-NATURAL highlighting started synchronized, remained
   synchronized after approximately 15 and 30+ seconds, tracked audible
   sentence boundaries, and stopped immediately with Stop.

Gate 4B is accepted. Gate 4C live rate/volume work is accepted below.

### Gate 4C — live native playback controls

**ACCEPTED.** WIN-NATURAL `setPlaybackRate` applies
the normalized setting directly to the persistent WAV element's browser
`playbackRate`, preserving canonical PCM timestamps and the existing
`currentTime` boundary scheduler. WIN-NATURAL `setOutputVolume` applies the
existing 0–200% product gain through one persistent
`MediaElementAudioSourceNode -> GainNode -> destination` graph, reused across
native chunks without resynthesis or audio replacement. Online and Windows
Legacy control routing remains delegated to the existing backends.

Human browser acceptance on fresh pages for correction candidate
`f5cbda3a145098be50ffd0c2db17945d514f90fb`:

- Live rate changes from 1.0x to approximately 2.0x and back to approximately
  0.7x passed without restart/resynthesis, gaps, overlap, or highlighting drift.
- Live volume changes from 100% to 0%, back to 100%, and through 150–200% gain
  passed without restart, gaps, pops, duplicates, or instability; highlighting
  remained synchronized.
- Quit followed by same-tab restart passed twice consecutively.
- Final smoke checks for live rate, live volume, Stop -> Play, and no observed
  regression passed.

Gate 4C lifecycle architecture: Stop/cancel is a reusable reset; Quit is final
dispose. Final disposal invalidates generation and tears down old audio, object
URLs, animation frames, handlers, Web Audio nodes/context, and inherited
direct-audio resources so the resident bootstrap can create a fresh ReaderApp
in the same tab.

Known deferred limitations: WIN-NATURAL startup/synthesis latency remains high
for a local/offline voice, and Pause -> Resume restarts the current sentence
instead of preserving an exact intra-sentence media position. Neither is fixed
in this closeout. The `WIN-NATURAL startup/synthesis latency optimization` is
accepted; Gate 5 is accepted and promoted.

## WIN-NATURAL latency optimization — ACCEPTED

Human Edge measurements using the existing latency diagnostics established that
warm SAPI synthesis is the steady-state bottleneck. A 49-character warm request
took about 61 ms for `Speak` and about 129 ms from dispatch to media playback.
A 900-character warm request took about 1010 ms for `Speak` and about 1234 ms
from dispatch to media playback, while producing about 50.9 seconds of PCM.
The first `SelectVoice` took about 176 ms; later selections were effectively
0 ms. Native transport and browser media setup were secondary contributors.

The accepted optimization is WIN-NATURAL-only: target 120 characters for the
first chunk and 900 for later chunks while preserving sentence boundaries, then
prefetch exactly one next synthesis. The first target is soft and does not
force a mid-sentence split. A ready next response is promoted on media
`ended`; consuming N+1 begins prefetch of N+2, while a pending prefetch waits
cleanly without overlap. Generation/session/chunk/voice/payload checks prevent
stale work from changing audio, timing, highlighting, or the reader cursor.
Current rate and volume are applied at promotion time. Stop/cancel, backend
switch, and final disposal invalidate foreground and prefetch state. The
helper, transport, PCM timing, Gate 4 lifecycle, Windows Legacy, and Online
Natural paths remain unchanged.

Fresh normal-reader QA on accepted candidate `de840901daf50c680a6bdceece1fe0550f5addb7`
passed: startup was dramatically faster, there was no audible inter-chunk gap,
highlighting remained synchronized, and Stop continued to work normally.
Warm measurements motivating the design were approximately 61 ms Speak/render
and 129 ms dispatch-to-media for 49 characters with 2.86 seconds of PCM, and
1009 ms Speak/render and 1234 ms dispatch-to-media for 900 characters with
50.9 seconds of PCM. The evidence showed roughly 50x realtime synthesis
throughput; the dominant UX problem was blocking startup on a large fully
rendered first chunk, not insufficient overall synthesis throughput.

Residual, non-blocking latency remains: WIN-NATURAL startup is still somewhat
slower than Windows Legacy; the first observed SelectVoice cost was about
176 ms and later selections were approximately 0 ms; browser/media startup and
the existing base64 transport add smaller costs. These are deferred and were
not optimized in this closeout. Exact intra-sentence Pause/Resume fidelity also
remains a separate deferred issue.

Gate 4 is complete. Gate 5 is accepted and promoted.

### Purpose

Complete the high-quality user experience around the Windows Natural backend.

### Required manual checks

```text
word highlighting tracks native timing
highlighting follows browser media clock
speed changes are live without resynthesis where designed
volume changes are live
pitch behavior is acceptable/preserved by browser playback strategy
consecutive synthesis requests reuse persistent helper
warm request latency is visibly lower than cold startup
Stop leaves no orphan audio
Quit leaves no orphan audio/native work
multi-tab audio ownership still behaves correctly
```

### Native evidence

```text
SpeakProgress boundaries are returned
WAV/audio payload is valid
boundary/request IDs match synthesis request
cancel terminates active synthesis cleanly
```

### Status

Accepted. Gate 4A, Gate 4B, Gate 4C, and Gate 5 are complete; Gate 5 is
**ACCEPTED AND PROMOTED**.

## Gate 5 — promotion candidate

### Purpose

Produce one exact commit that is safe to promote to the load-bearing stable reader.

### Required automated checks

```text
npm test
npm run check
git diff --check
native helper build/tests
```

### Candidate and promotion baseline

- Accepted candidate: `360460a99a0b52cc5d45fa3c406c84f881f9752c`
- Promoted stable SHA: `360460a99a0b52cc5d45fa3c406c84f881f9752c`
- Rollback SHA: `c089d08ece6009592faa2fdf4306e4ce873e4ea8`
- Pre-promotion merge-base: `c089d08ece6009592faa2fdf4306e4ce873e4ea8`
- Stable policy: [`docs/STABILITY.md`](../STABILITY.md)

The stable-to-candidate diff is classified as intended WIN-NATURAL integration,
diagnostics, native helper/setup, tests, lifecycle/reader integration, latency
optimization, and documentation. No untracked files, generated binaries,
merge-conflict markers, or temporary production tracing were found. The
candidate manifest adds `nativeMessaging`; stable promotion therefore requires
registering the native host for the stable unpacked extension ID after the
promotion, as described in `docs/STABILITY.md`. No machine configuration was
changed during preparation.

### Required small human browser matrix

Use fresh pages after loading the exact candidate and perform only these stages:

```text
A — Existing backends: Windows Legacy Zira audible; Online Aria audible;
    switch between them and confirm each remains the selected backend.
B — WIN-NATURAL core: Microsoft Aria starts quickly; sustained playback and
    highlighting stay synchronized with no chunk gap; live rate changes work;
    live volume changes work.
C — Lifecycle: Stop -> Play; Quit -> same-tab restart; switch away from
    WIN-NATURAL and back; confirm no ghost or overlapping audio.
```

Do not treat Pause/Resume exact-position fidelity as part of this candidate
matrix. Gate 5 was accepted by human QA on a genuinely fresh webpage after
reloading the development extension.

The accepted fresh-page matrix passed Windows Legacy Zira, Online Aria,
Zira -> Online Aria -> Zira switching, fast WIN-NATURAL Aria startup,
sustained synchronized playback, live rate and volume, no chunk gaps,
Stop -> Play, Quit -> same-tab restart, WIN-NATURAL -> Online Aria ->
WIN-NATURAL switching, and no ghost or overlapping audio.

### Gate 5 QA block — Online Natural regression

Human QA on candidate `22c23a73636057fa0fdf8c1f1dd66f80084cc023` passed
Windows Legacy Zira and WIN-NATURAL Microsoft Aria, but Online Natural Aria
did not produce working playback. The separate stable profile passed Online
Aria, so this is recorded as a development-candidate regression rather than an
external service outage. Gate 5 promotion QA is blocked until Online Aria is
restored and re-verified.

The last development acceptance explicitly recording Online Aria playback was
Gate 3C closeout `99ae6695cf4f9641714b455d27dd3c588a987457`; the exact direct
Online engine remains the behavioral control. Current direct-audio diagnostics
already expose route selection, mapped voice, WebSocket open/request, received
audio, Blob creation, and `HTMLMediaElement.play()` resolution/rejection for
the one focused follow-up trace. No speculative Online backend change is made
until that first semantic divergence is observed.

### Gate 5 correction — hot-path diagnostic observer investigation

Fresh-page browser evidence showed that Online Aria selected the correct
development route, opened the WebSocket, sent the request, and received
metadata plus approximately 573 KB of audio frames, but never reached
`turn.end`, Blob creation, or `play()`. The reader eventually reported
`Read Aloud websocket timed out`, while the console contained more than 1,000
lines, including hundreds of per-frame diagnostics. This localizes the current
correction target to observer-induced work in the WebSocket message path rather
than routing, synthesis, or browser playback.

History inspection shows both per-frame logs were introduced by
`81ef5b5d9ede223be82887e768e069337f1458e0`, which predates the last explicit
development Online Aria acceptance at
`99ae6695cf4f9641714b455d27dd3c588a987457`. Thus the timing evidence does not
prove that logging was newly introduced after that acceptance, but the logs are
still unnecessary hot-path work and are the narrowest controlled correction.
The correction removes per-frame console calls, retains phase logs and one
`turn.end` summary with audio/metadata frame counts, preserves the absolute
12-second timeout, and adds a deterministic hundreds-of-frames regression
test. Human QA on `360460a99a0b52cc5d45fa3c406c84f881f9752c` then confirmed
Online Aria playback and the complete Gate 5 matrix. The stable profile still
requires separate Native Messaging registration for its own unpacked ID.

Gate 5 is accepted and promoted. The failed candidate remains documented as a
development regression: stable control was good; the active trace showed
healthy audio streaming but timed out before `turn.end`; removing per-frame
diagnostic logging corrected the issue without changing the 12-second timeout
or Direct Audio transport semantics.

### Promotion rule

Stable moves only after the user explicitly accepts the exact candidate in Edge.

Do not promote because:

- Codex reports success;
- unit tests pass;
- the helper works from PowerShell;
- source inspection looks correct;
- a different commit/browser profile worked.

## Re-verification after environment changes

Repeat relevant Gate 1+ checks if any of these change:

```text
Edge major version / Native Messaging behavior
NaturalVoiceSAPIAdapter version
compatible Narrator package
adapter DLL registration
NarratorVoices junction target
helper target framework/runtime
unpacked extension ID
Native Messaging manifest path
Windows user/profile
```

## Evidence preservation

When a diagnostic object is large, save/copy it as JSON rather than relying on screenshots. Preserve fields such as:

```text
connected
handshake
voices
ariaFound
ariaVoice
helperDiagnostics.executablePath
helperDiagnostics.parentProcess
helperDiagnostics.userSid
helperDiagnostics.integrityLevel
helperDiagnostics.installedVoiceCount
helperDiagnostics.registry.summary
```

These fields were sufficient to discriminate most Gate 1 hypotheses.

## Acceptance history

### Gate 0

Accepted after fresh-profile Online Natural activation fix and full reader regression QA.

### Gate 1

Accepted after:

1. persistent x64 Native Messaging transport worked;
2. Edge/direct registry discrepancy was characterized;
3. `NarratorVoices` filesystem junction exposed Aria to Edge;
4. Aria matcher stopped depending on a hard-coded token ID;
5. temporary Edge direct-launch policy was removed;
6. Aria still enumerated under normal Edge launch;
7. Online Natural, Windows Legacy, Stop, and Quit all passed manual regression QA.

### Gate 2

Accepted after:

1. Windows Natural appeared as a distinct catalog class;
2. Aria appeared with the real `Local-NarratorVoices` token and remained disabled/catalog-only;
3. an initial name-collision regression was found in browser QA;
4. backend-aware selection keys replaced name-only identity;
5. Zira and Mark playback worked again;
6. Online Aria playback worked;
7. switching back to Zira retained and played Zira correctly;
8. Stop and Quit passed;
9. non-Aria Online failures were diagnosed as not demonstrably introduced by Gate 2 and were kept out of Gate 2 scope.

### Gate 3A

Accepted after human browser QA confirmed:

1. the isolated diagnostics page connected with protocol 1 and x64 helper;
2. Microsoft Aria enumerated as `Local-NarratorVoices`;
3. the diagnostic phrase played audibly through local Aria;
4. diagnostic Stop worked immediately;
5. a fresh normal reader page preserved Windows Legacy Zira and Online Aria;
6. WIN-NATURAL remained visible but disabled/catalog-only;
7. Online William's known limitation was not treated as a Gate 3A regression.

### Gate 3B

Accepted after human browser QA confirmed:

1. the diagnostics page used the background-owned transport and displayed
   `Connected via background — protocol 1, x64`;
2. Microsoft Aria enumerated as `Local-NarratorVoices`;
3. diagnostic Aria playback was audible;
4. diagnostic Stop worked;
5. a fresh normal reader page preserved Windows Legacy Zira and Online Aria;
6. WIN-NATURAL remained visible but disabled/catalog-only.

Gate 3C was not started.

### Gate 3C

Accepted after fresh-page human browser QA confirmed:

1. Windows Legacy Zira playback;
2. Online Aria playback and highlighting;
3. selectable and audible WIN-NATURAL Microsoft Aria;
4. sustained native progression without repeated sentence/chunk loops;
5. native Stop, Pause, Resume, and Quit;
6. clean switching among WIN-NATURAL, Windows Legacy, and Online Natural;
7. no overlapping or ghost audio.

Automated coverage exercises native routing through the stacked local/direct
speech engine, exact-token synthesis requests, large-response validation,
generation-safe Stop cleanup, backend switching, single completion, and the
boundaryless-completion watchdog exemption. Native latency, native timing/
highlight synchronization, and intra-sentence Pause/Resume fidelity remain
explicit Gate 4/backlog work.

Future gates should append similarly explicit acceptance histories rather than overwriting earlier evidence.
