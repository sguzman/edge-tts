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

## Gate 3 — isolated Windows Natural playback

### Purpose

Route only an explicitly selected Windows Natural voice through the native backend.

### Required manual checks

```text
Microsoft Aria reads a short page selection
works with network disabled / offline condition
actual SAPI token returned by enumeration is used
Windows Natural Stop works
Quit cancels/clears native session
Online Natural remains unchanged
Windows Legacy remains unchanged
helper errors do not kill the reader
```

### Required architectural evidence

```text
backend ownership is explicit
native request IDs are correlated
cancel cannot accidentally target Online Natural
no reader-startup dependency introduced
```

### Status

Pending.

## Gate 4 — timing, highlighting, live controls, warm reuse

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

Pending.

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

### Required manual browser checks

At minimum:

```text
HUD starts once
Online Natural works
Windows Legacy works
Windows Natural works
Windows Natural works offline
voice taxonomy is correct
Pause/Resume works
Stop works
Quit works
highlighting works
speed works
volume works
repeat playback works
no startup deadlock if native host unavailable
```

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

Future gates should append similarly explicit acceptance histories rather than overwriting earlier evidence.
