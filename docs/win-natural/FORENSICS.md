# Windows Natural forensic history

This document records the investigation that led to the current Windows Natural integration. It is intentionally more detailed than a setup guide. The purpose is to preserve the causal history: which observations were real, which hypotheses were wrong, and which implementation choices exist because of browser or Windows behavior that was not obvious from documentation.

## Browser candidate QA rule: use a fresh page after extension changes

After changing, reverting, or reloading the unpacked extension, browser acceptance
must be performed on a newly opened page or on a fully reloaded page that has not
retained a reader runtime from another candidate. Never infer the current source
candidate's behavior from a tab that previously hosted another build.

This became decisive during Gate 3 recovery. The repository had been reverted to
the browser-accepted Gate 2 tree, but an existing tab that had previously hosted
the failed Gate 3 injection still behaved as though the failed runtime were
present. On a genuinely new page after reloading the extension, Windows Legacy
Zira and Online Aria both passed again.

The likely mechanism is that the page-resident injected extension namespace and
reader runtime can survive long enough to make an existing tab untrustworthy
during extension-reload development. The reader bootstrap has an existing-runtime
sentinel/readiness optimization intended to avoid duplicate injection. That
optimization is useful during normal operation, but it means a stale page can
masquerade as the current unpacked-extension candidate after a reload or revert.

The required control procedure is therefore:

1. Reload the unpacked extension.
2. Open a new tab/page, or fully reload a page that never hosted the prior
   candidate runtime.
3. Perform browser acceptance only in that fresh page.
4. Treat behavior from a previously injected tab as stale until the page is
   discarded and recreated.

## 1. Original objective

The project already had two working categories of speech:

- Windows-local legacy voices; and
- Microsoft Edge online Natural voices through a direct MP3 transport.

The missing category was a **high-quality local/offline Natural voice** with low enough latency to use as the reader's normal voice even when network quality is poor.

The target was Microsoft Aria because it is available as a Windows Narrator Natural voice and has acceptable local synthesis quality.

## 2. Why ordinary Windows speech APIs were insufficient

Current Narrator Natural voices are not simply exposed like David/Zira/Mark through ordinary SAPI/OneCore enumeration. The modern Store packages are private to the Narrator stack and are not directly visible through the public APIs used by the extension.

`NaturalVoiceSAPIAdapter` provides a bridge by exposing compatible Narrator packages as SAPI voices.

The important word is **compatible**. The newest Store package generation changed in ways that broke the adapter's older extraction/decryption expectations. Therefore the project did not simply point SAPI at the currently installed Store Aria package.

## 3. Successful local proof of concept

A compatible older Aria v2 package was extracted into a dedicated work directory. The current Store Aria package was left untouched.

The successful proof used:

```text
NaturalVoiceSAPIAdapter: v0.2.4 x64
voice: Microsoft Aria
language: en-US
adapter token: Local-aria-v2
```

The proof demonstrated:

- SAPI enumeration;
- offline synthesis with Ethernet disabled;
- valid WAV output;
- mono 16-bit 22050 Hz PCM;
- SAPI `SpeakProgress` boundaries;
- persistent helper reuse;
- significantly lower warm synthesis latency than cold startup.

That established that the underlying local model was viable before any browser integration was attempted.

## 4. First browser integration failure

The first Windows Natural integration was too broad. It mixed:

- Native Messaging;
- voice discovery;
- new speech-engine inheritance;
- startup readiness;
- toolbar/catalog changes;
- playback;
- lifecycle/cancel behavior;
- browser reload/session handling.

Automated tests remained green while the real extension became unusable. Symptoms included:

```text
HUD stuck at Starting speech…
no playback
Quit ineffective
Aria absent
duplicate/stale HUD behavior during some iterations
```

The important lesson was not merely that one bug existed. The integration had created too many simultaneous causal surfaces to reason about safely.

## 5. Stable/runtime separation

The recovery response was structural.

A `stable` branch was pinned to the last browser-known-good reader, while the experimental line remained separate. The original local filesystem path was kept for the stable worktree so the primary Edge profile could continue loading the same physical extension path. A sibling development worktree and a second Edge profile became the test environment.

This changed the project's operating rule:

> experimental native integration is never again allowed to take away the reader used for actual reading.

The stable runtime is an appliance. Development is disposable.

## 6. Gate 0: re-prove the baseline

The clean reintegration branch started from stable and initially contained no Windows Natural code.

Windows Legacy voices worked in the fresh development profile. Online Natural voices initially appeared but did not play.

The relevant asymmetry was:

```text
Windows Legacy: works
Online Natural: visible, silent
```

The direct Online Natural backend creates an audio element and eventually calls `audio.play()` only after asynchronous ownership and WebSocket synthesis work. In a fresh Edge profile the original user activation could expire before the actual playback call.

The Gate 0 repair added a synchronous playback-unlock preparation during the Play/Resume gesture while leaving synthesis asynchronous.

Manual browser acceptance then passed:

```text
Online Natural first playback: PASS
Online Natural second playback: PASS
Stop: PASS
Quit: PASS
Windows Legacy: PASS
```

This mattered later because every native change was required to preserve that exact state.

## 7. Gate 1 initial Native Messaging transport

Gate 1 was intentionally transport-only:

```text
hello
voices
```

No Aria voice-picker entry. No Windows Natural reader playback. No new speech-engine inheritance.

The helper was x64, persistent, and Native Messaging-framed. The browser could establish a connection and receive:

```text
protocol: 1
architecture: x64
```

But voice enumeration returned:

```text
voices: []
ariaFound: false
```

At this point the transport itself was working. The failure was local voice visibility inside the Edge-launched helper process.

## 8. A separate Gate 1 regression: the second runtime message listener

An early Gate 1 implementation installed a second global `chrome.runtime.onMessage` listener solely for Native Messaging diagnostics.

After that change, Online Natural regressed to `Starting speech…` even though its direct-audio files were unchanged.

Removing the second listener restored the original dispatcher topology and avoided the regression. The diagnostic entry point was kept as a direct service-worker API instead of another runtime listener.

This is why Gate 1 diagnostics are invoked directly from the service worker:

```javascript
globalThis.EdgeTtsNativeMessaging
  .createTransport()
  .diagnostics()
```

The lesson is subtle but important: even apparently unrelated extension-global message listeners can change runtime behavior enough to endanger previously working paths. Diagnostics should be isolated just like production capability discovery.

## 9. The direct-vs-Edge enumeration contradiction

The same helper executable behaved differently depending on who launched it.

### Direct launch

The helper reported approximately:

```text
user: same Windows account
x64: true
installedVoiceCount: 6
Local-aria-v2 / Microsoft Aria: present
NarratorVoicePath: present, rooted, exists
```

### Edge Native Messaging launch

The helper reported:

```text
same Windows account
same SID
medium integrity
x64
installedVoiceCount: 22
voices: []
NarratorVoicePath: null
```

The 22 voices included legacy Windows voices and multiple `Edge-*` online voices. That proved the adapter/SAPI ecosystem was loading, but the configured local Narrator package was absent.

## 10. Identity and token hypotheses ruled out

Diagnostics were expanded to compare the two process contexts.

The Edge-launched helper was shown to have:

```text
same Windows user name
same user SID
medium integrity
x64 process
not AppContainer
not restricted
limited elevation type
virtualization allowed but disabled
no package SID
```

Therefore the problem was **not**:

- a different Windows user;
- a different SID;
- x86 versus x64;
- simple UAC elevation mismatch;
- AppContainer isolation;
- restricted-token isolation;
- registry virtualization being enabled.

## 11. Raw registry evidence

The adapter configuration key physically existed and was readable from PowerShell at both:

```text
HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator
HKEY_USERS\<same-user-SID>\Software\NaturalVoiceSAPIAdapter\Enumerator
```

Direct helper probes could see it.

Inside the Edge-launched helper, both managed registry APIs and raw Win32 `RegOpenKeyEx` calls returned:

```text
HKCU exact adapter key: ERROR_FILE_NOT_FOUND
HKEY_USERS\<same SID> exact adapter key: ERROR_FILE_NOT_FOUND
RegOpenCurrentUser root handle: ERROR_SUCCESS
```

This occurred in both explicit 64-bit and 32-bit registry views.

That is why the final integration avoids requiring the per-user adapter key for browser discovery. The problem was not permission denied; the exact subkey was effectively absent from the Edge-launched process's view.

## 12. The cmd.exe launch hypothesis

Edge initially launched the Native Messaging helper through `cmd.exe`.

Microsoft Edge has a policy, `NativeHostsExecutablesLaunchDirectly`, which can force executable native hosts to launch directly.

The policy was temporarily enabled. After a full Edge restart, the process topology changed from:

```text
msedge.exe
  -> cmd.exe
      -> WinNaturalHost.exe
```

to:

```text
msedge.exe
  -> WinNaturalHost.exe
```

This was a useful controlled experiment because it changed one launch variable.

It did **not** fix registry visibility or Aria enumeration.

Therefore the `cmd.exe` intermediary was falsified as the root cause. The policy was later removed, and the final solution continued to work under the normal launch mode.

## 13. Filesystem-default discovery breakthrough

The key insight was to stop trying to make Edge see the adapter's per-user registry configuration.

`NaturalVoiceSAPIAdapter` supports a default Narrator package location beside the x64 adapter DLL:

```text
<adapter-x64-dir>\NarratorVoices
```

That directory did not exist on the verified machine.

A reversible directory junction was created:

```text
<adapter-x64-dir>\NarratorVoices
    -> <working extracted Aria v2 directory>
```

No package was copied or moved.

After a full Edge restart, the Edge-launched helper immediately gained one additional local voice:

```text
id: Local-NarratorVoices
name: Microsoft Aria
lang: en-US
```

`installedVoiceCount` increased from 22 to 23.

The registry was still invisible inside the Edge-launched helper. That was fine: the adapter could now discover Aria through its documented filesystem default.

## 14. Token identity changed

The proof-of-concept registry-configured path produced:

```text
Local-aria-v2
```

The filesystem-default `NarratorVoices` path produced:

```text
Local-NarratorVoices
```

This proved the adapter token ID is discovery-path dependent.

The project's first diagnostic matcher incorrectly assumed `Local-aria-v2` was canonical, so `ariaFound` stayed false even after the voice was visibly present.

The matcher was corrected to preserve the real token ID and identify Aria logically by:

```text
ID prefix: Local-
name: Microsoft Aria
language: en-US
```

That is now an architectural rule, not just a test adjustment.

## 15. Policy cleanup proved the real fix

After the junction was working, the temporary `NativeHostsExecutablesLaunchDirectly` policy was removed from HKLM and Edge was fully restarted.

Edge returned to the `cmd.exe` intermediary.

Aria still enumerated successfully:

```text
voices:
  Local-NarratorVoices / Microsoft Aria / en-US
ariaFound: true
parent process: cmd
```

That final experiment is important because it separates **the causal fix** from **a temporary debugging condition**.

The causal fix was the registry-independent filesystem discovery junction.

The Edge policy was unnecessary.

## 16. Gate 1 final regression acceptance

With the junction active and the temporary policy removed, manual browser QA confirmed:

```text
Windows Legacy playback: PASS
Online Natural playback: PASS
Online Natural after pause: PASS
Stop: PASS
Quit: PASS
Native Messaging handshake: PASS
x64 helper: PASS
Microsoft Aria enumeration: PASS
```

That closed Gate 1.

## 17. Dead ends and why they were useful

### Stale extension/session cleanup

During the first broken integration, stale HUD/session behavior was real, but fixing it did not restore speech. It was a valid bug, not the root cause of the whole regression.

### Native Messaging request through runtime.sendMessage

Calling `chrome.runtime.sendMessage` from the service-worker console produced `Receiving end does not exist` after the diagnostic listener was intentionally removed. The correct Gate 1 diagnostic is direct invocation of the service-worker transport API.

### Browser Native Messaging registration

Registration was not the enumeration problem. The helper connected successfully and returned a correct protocol/x64 handshake.

### Wrong architecture

Ruled out. Both helper PE and runtime diagnostics were x64.

### Wrong Windows user

Ruled out by exact SID comparison.

### AppContainer/restricted token

Ruled out by token diagnostics.

### cmd.exe intermediary

Plausible, tested, falsified.

### Exact token ID matching

Incorrect design. Token IDs changed with adapter discovery path.

## 18. What should never be repeated

Future maintainers should not repeat these expensive investigations unless the underlying assumptions materially change:

- do not expect current Store Narrator Natural voices to behave like ordinary SAPI voices;
- do not assume a directly launched helper sees the same per-user registry state as an Edge-launched Native Messaging process;
- do not treat `Local-aria-v2` as a permanent Aria identifier;
- do not add optional native discovery to reader startup readiness;
- do not add extension-global listeners casually to "just expose diagnostics";
- do not use green unit tests as evidence that the unpacked extension is healthy;
- do not mutate the stable runtime to test experimental native work;
- do not keep an Edge enterprise policy enabled just because it happened to be part of a successful intermediate experiment.

## 19. Open questions

The exact Windows/Edge mechanism causing the same-SID Native Messaging process to see a different view of the adapter's per-user registry key was not fully explained. The project gathered enough evidence to avoid depending on the problematic path, and the filesystem-default solution is simpler and more robust.

If a future maintainer chooses to investigate the OS mechanism further, treat it as separate research. It is not a blocker for the working integration.

## 20. Future additions

When Gates 2–5 are completed, extend this document with the same discipline:

- record the browser-visible failure, not merely the code symptom;
- state the hypothesis;
- state the experiment used to discriminate it;
- record what was falsified;
- record the final causal fix;
- preserve rollback instructions;
- record the exact manual acceptance behavior.

The point of this file is not to celebrate clever debugging. It is to make clever debugging unnecessary next time.

## Gate 3A decomposition after the failed monolithic Gate 3

The failed monolithic Gate 3 combined native playback with ReaderApp routing,
reader watchdogs, backend inheritance, catalog selection, and normal-page audio
lifecycle. Although native synthesis itself worked, that composition regressed
Online Natural, Windows Legacy, and native batch completion. Its commits remain
in Git history for forensic reference, but the implementation was reverted to
the accepted Gate 2 runtime.

The replacement decomposition is deliberately staged:

```text
Gate 3A — isolated diagnostics-page native playback
Gate 3B — background-owned native synthesis, still outside ReaderApp
Gate 3C — minimal normal-reader WIN-NATURAL routing
Gate 4  — timing, highlighting, live controls, and performance
```

Gate 3A proves only the diagnostic-page path: HTMLAudioElement unlock,
Native Messaging, SAPI token validation, in-memory WAV synthesis, multipart
transport, and page-owned playback. It must not alter normal reader injection,
catalog selection, audio ownership, or any existing playback backend.

Gate 3A was accepted by human browser QA on a fresh diagnostics page and a fresh
normal reader page. The diagnostic page reported protocol 1/x64, enumerated
`Local-NarratorVoices / Microsoft Aria`, played audible local Aria speech, and
stopped immediately. The fresh reader page preserved audible Windows Legacy Zira
and Online Aria, with WIN-NATURAL still visible but disabled/catalog-only.
Online William remained non-audible as the previously known Online voice issue;
that observation was not attributed to Gate 3A.

Gate 3B changes only the ownership boundary for that already-proven diagnostic
path. The diagnostics page now sends explicit extension messages for enumeration
and synthesis; the service worker lazily creates and caches one Native Messaging
transport, invalidates it on disconnect/error, and reconnects later. The native
helper multipart protocol is unchanged. The service worker returns the bounded
base64 WAV response to the page, which still owns gesture unlock, playback,
Stop/generation invalidation, and object-URL revocation. ReaderApp remains
untouched; Gate 3C is still the future reader-integration gate.

Gate 3B was accepted by human browser QA on fresh pages after reloading the
unpacked extension. The diagnostics page reported
`Connected via background — protocol 1, x64`, enumerated
`Local-NarratorVoices / Microsoft Aria`, produced audible local Aria speech,
and Stop worked. A fresh normal reader page preserved audible Windows Legacy
Zira and Online Aria, while WIN-NATURAL remained visible but
disabled/catalog-only. Gate 3C was deliberately not started.

## Gate 3C candidate: minimal normal-reader native routing

Gate 3C integrates Windows Natural into the existing `LocalTtsSpeechEngine`.
It does not add another wrapper to the speech-engine inheritance chain. The
normal reader sends the exact `nativeVoiceId` and batch text through the
accepted Gate 3B background request path; the service worker remains the sole
Native Messaging owner. The page-side local engine reconstructs the bounded
WAV, owns its HTMLAudioElement and object URL, and reports start/end through
the existing reader callbacks.

Native state is separate from Chrome TTS and Online direct MP3 state. Backend
switches clear native audio, pending generation, and object URLs before
delegating to the existing Windows Legacy or Online route. Stop, destructive
Pause/resume, Quit, and audio-owner preemption therefore invalidate pending
native responses and cannot leave native audio playing.

Gate 3C has no native word boundaries, native live speed control, or warm
performance optimization. A native request advertises completion ownership
without boundaries; ReliableReader and the failsafe liveness watchdog skip
their legacy no-boundary retry/continuation timers only for that active native
session. Ordinary Web Speech and direct Online safeguards remain enabled.
Gate 4 owns native timing/highlighting and live controls.

Gate 3C was accepted by human browser QA on fresh pages. Windows Legacy Zira,
Online Aria, and selectable WIN-NATURAL Microsoft Aria were audible; sustained
native playback progressed without repeated batches; native Stop, Pause,
Resume, Quit, and all backend switches passed; and no ghost audio remained.

The following remain deliberately deferred to Gate 4/backlog: native
startup/synthesis latency, native word/sentence highlight synchronization, and
intra-sentence Pause/Resume position fidelity. Preserve the fresh-page rule
after every extension reload, but do not treat these known limitations as Gate
3C failures.

## Gate 4A acceptance: native timing substrate

Gate 4A was accepted after browser QA on the reloaded development diagnostics
page. Microsoft Aria enumerated through the background, played audibly, and
Stop stopped playback. The diagnostic reported timing captured `YES`, 6
boundaries, first boundary `char 0, len 7, audio 160.25 ms`, last boundary
`char 39, len 7, audio 2169.333 ms`, and monotonic timing `YES`.

The preserved contract is `{ charIndex, charLength, audioMs }`, where offsets
are relative to the exact synthesis-request text and `audioMs` is the SAPI
audio position in milliseconds. Gate 4A deliberately stops before mapping
timing to reader segments or changing presentation behavior. Gate 4B is
accepted, and Gate 4C is accepted as recorded in the verification log.

Gate 4C human browser acceptance on fresh pages for correction candidate
`f5cbda3a145098be50ffd0c2db17945d514f90fb` passed live rate changes from 1x
to approximately 2x and back to approximately 0.7x, live volume from 100% to
0%, back to 100%, and through 150–200%, with no restart, gap, overlap, or
highlighting drift. Stop/Play passed. Quit followed by same-tab restart passed
twice consecutively after final engine disposal was added.

Gate 4C records the distinction between reusable reset and final disposal:
Stop/cancel preserves the same-engine native audio graph; Quit invalidates the
generation and tears down audio, object URLs, animation frames, handlers, Web
Audio nodes/context, and inherited direct-audio resources so the resident
bootstrap can create a fresh ReaderApp in the same tab.

Gate 4A, Gate 4B, and Gate 4C are accepted. Gate 5 is pending human browser QA
and has not been promoted. The WIN-NATURAL startup/synthesis latency optimization is accepted. Native startup
latency remains somewhat slower than Windows Legacy, and pause/resume's
current-sentence restart behavior remains a separate deferred limitation.

## Latency optimization: accepted first optimization

Fresh Edge measurements with the existing native latency diagnostics showed that
warm SAPI synthesis, rather than Native Messaging or browser playback, is the
steady-state bottleneck. A 49-character warm request measured about 61 ms for
SAPI `Speak` and about 129 ms dispatch-to-media. A 900-character warm request
measured about 1010 ms for `Speak` and about 1234 ms dispatch-to-media, with
about 50.9 seconds of PCM output. The first `SelectVoice` measured about 176 ms
and later selections were effectively 0 ms.

The accepted optimization keeps the helper and transport unchanged.
WIN-NATURAL chunks target 120 characters initially and 900 thereafter,
flushing at existing sentence/paragraph boundaries unless the emergency limit
is reached. The first target is soft. Once a current native WAV is accepted and
playing, exactly one next chunk is prefetched. A ready prefetch is promoted only
from that chunk's `ended` event; consuming N+1 begins prefetch of N+2, and a
pending response waits cleanly without overlap. Generation/session/chunk/
voice/payload checks prevent stale prefetches from playing or affecting timing,
highlighting, or cursor state. Rate and volume are read at promotion time.
Stop/cancel, backend switches, and final disposal clear prefetch state.

Fresh normal-reader QA on `de840901daf50c680a6bdceece1fe0550f5addb7` passed:
startup was dramatically faster, no audible chunk gap was observed,
highlighting remained synchronized, and Stop worked normally. The accepted
measurements were approximately 61 ms Speak/render and 129 ms dispatch-to-media
for 49 characters with 2.86 seconds of PCM, versus 1009 ms and 1234 ms for 900
characters with 50.9 seconds of PCM. Synthesis throughput was about 50x
realtime, so whole-first-chunk batching—not slow overall synthesis—was the
dominant latency problem. Residual cold SelectVoice (~176 ms first observed,
then ~0 ms warm), browser/media startup, and base64 transport costs remain
non-blocking deferred opportunities. No streaming or transport redesign was
justified.

## Gate 5 promotion block: development Online Natural failure

Human QA on exact candidate `22c23a73636057fa0fdf8c1f1dd66f80084cc023`
reported Windows Legacy Zira and WIN-NATURAL Microsoft Aria passing, but Online
Natural Aria failing to produce playback. Online Aria passed in the separate
stable Edge profile, so Gate 5 is blocked by a development regression and
stable must not be promoted.

Forensic comparison identifies `99ae6695cf4f9641714b455d27dd3c588a987457`
as the latest development commit with explicit human acceptance of Online Aria.
The direct MP3 implementation is functionally unchanged from the accepted Gate
0 implementation; later source changes are primarily native timing, native
controls/lifecycle, and native latency work. The existing narrow direct-audio
stage diagnostics are retained for one focused fresh-page trace before any
Online-specific fix is attempted.

### Gate 5 correction — per-frame logging and timeout evidence

The decisive development trace showed Online Natural route selection,
WebSocket connection, request dispatch, metadata, and large audio delivery,
followed by a timeout before `turn.end`; no Blob or browser `play()` occurred.
The same run produced more than 1,000 console lines and hundreds of audio-frame
log entries. This makes synchronous per-frame console logging a plausible
observer-induced timeout mechanism in the active WebSocket handler.

`git blame` and pickaxe history identify `81ef5b5d9ede223be82887e768e069337f1458e0`
as the source of both `received metadata frame` and `received audio frame`
logging. It predates the last explicit human-good Online Aria commit
`99ae6695cf4f9641714b455d27dd3c588a987457`, so the temporal comparison is
not, by itself, proof of a newly introduced regression. The controlled Gate 5
correction removes only those hot-path console calls, counts frames, and keeps
one bounded `turn.end` summary plus existing phase/error/timeout diagnostics.
The timeout constant remains 12 seconds and no Online protocol, streaming, or
WIN-NATURAL behavior is changed. Fresh browser QA is required to determine
whether the observer effect explains the timeout.
