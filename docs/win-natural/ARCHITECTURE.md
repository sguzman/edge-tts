# Windows Natural architecture

This document defines the intended architecture for local Windows Natural voices and the boundaries that must not be violated while the backend is completed.

## 1. Backend taxonomy

The reader has three semantically distinct voice families:

### Windows Legacy

Classic Windows voices exposed through the existing Windows/Web Speech/`chrome.tts` path.

Examples:

```text
Microsoft David
Microsoft Mark
Microsoft Zira
```

These are local and comparatively simple, but they are not the high-quality Narrator Natural model this integration is adding.

### Windows Natural

A local Narrator Natural package exposed to SAPI by `NaturalVoiceSAPIAdapter`, then consumed by this project's x64 Native Messaging helper.

Verified logical voice:

```text
Microsoft Aria
en-US
```

The actual SAPI token ID is implementation data and may vary with discovery path. Observed IDs include:

```text
Local-aria-v2
Local-NarratorVoices
```

The project therefore treats `Local-*` as the adapter-backed family and preserves the real token ID for native calls.

### Online Natural

Microsoft Edge/Read Aloud Natural voices reached by the existing direct WebSocket + MP3 backend.

These are network-backed and must remain independent from Windows Natural.

## 2. Process model

The target architecture is:

```text
Edge extension UI/content script
        |
        | browser messages / Native Messaging requests
        v
Edge service worker
        |
        | chrome.runtime.connectNative
        v
persistent x64 WinNaturalHost.exe
        |
        | System.Speech / SAPI
        v
NaturalVoiceSAPIAdapter x64
        |
        | local Narrator model/package
        v
Microsoft Aria Natural voice
```

The browser owns presentation, reader state, and eventual audio playback. The helper owns native synthesis work and Windows-specific interop.

## 3. Why a persistent helper

Starting a Natural model repeatedly is unnecessarily expensive and can destroy responsiveness. The helper is intentionally persistent so the adapter/model can remain warm across requests.

The browser should not spawn a new native process for every phrase.

The helper lifecycle should therefore be closer to a service connection than a one-shot CLI invocation:

```text
connect
hello
voices
[synthesize]
[cancel]
[synthesize]
...
disconnect/shutdown
```

Later gates may extend the protocol, but request correlation and failure isolation are required from the beginning.

## 4. Protocol invariants

Every request must have an explicit request ID. Responses must correlate to the originating request.

Native Messaging uses Chromium framing:

```text
4-byte little-endian payload length
UTF-8 JSON payload
```

stdout is protocol-only. Human-readable logs must not corrupt framing.

Every browser-side request must have a timeout. A missing, dead, malformed, or incompatible helper must not leave a promise pending forever.

At Gate 1 the protocol includes:

```text
hello
voices
```

Later gates may add:

```text
synthesize
cancel
shutdown
boundary
audioChunk
synthesisEnd
error
```

The exact future event names should remain versioned and request-correlated.

## 5. Startup isolation

Windows Natural discovery is optional capability discovery. It must not be part of core reader readiness.

Bad architecture:

```text
reader startup
  -> wait for native helper
      -> helper missing/hung
          -> entire reader never starts
```

Required architecture:

```text
reader startup --------------------------> ready
       \
        \ optional asynchronous native capability discovery
```

If the helper is missing, broken, unauthorized, or slow, Online Natural and Windows Legacy must still work.

This rule exists because the first integration attempt violated the spirit of this separation and made an optional backend capable of breaking the load-bearing reader.

## 6. UI-thread rule

No heavy native work belongs on the UI/render path.

A user action may synchronously emit a lightweight work request, but synthesis, model work, package inspection, and blocking native operations belong in asynchronous worker/native-host execution.

The render/UI thread renders and handles lightweight interaction. It does not synthesize speech, enumerate huge registries, or wait on filesystem/model work.

## 7. Voice identity model

Do not use the SAPI token ID as the permanent logical identity of a Windows Natural voice.

Observed behavior proved that adapter token IDs are discovery-path dependent. Therefore model the fields separately:

```text
backend class: windows-natural
adapter family: Local-*
logical name: Microsoft Aria
language: en-US
actual token id: Local-NarratorVoices   # example, runtime data
```

The actual token ID is still crucial: later synthesis requests must use the exact installed token. It is simply not suitable as the canonical human/product identity.

## 8. Adapter discovery model

There are two possible adapter configuration channels:

### Registry-configured path

The proof-of-concept used:

```text
HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator\NarratorVoicePath
```

This works for directly launched processes on the verified machine.

### Filesystem-default path

For Edge Native Messaging, per-user adapter registry configuration was not visible even under the same SID. The robust browser path therefore uses:

```text
<adapter-x64-dir>\NarratorVoices
```

as the adapter's registry-independent default discovery location, implemented as a directory junction to the extracted compatible voice package.

The filesystem-default path is the preferred browser-integration mechanism because it survived both Edge native-host launch modes tested during Gate 1.

## 9. Browser/native ownership split

The native helper should not become a second reader UI or a second source of reader truth.

Recommended ownership:

### Extension/browser owns

- selected voice and user settings;
- document/text segmentation;
- current reader position;
- toolbar/HUD;
- audio ownership between tabs;
- presentation/highlighting;
- browser playback controls;
- eventual media-clock synchronization;
- user-facing failure status.

### Native helper owns

- SAPI voice enumeration;
- selecting the actual SAPI token;
- speech synthesis;
- SAPI `SpeakProgress` timing capture;
- cancellation of native synthesis;
- returning audio/timing data to the extension.

The helper should remain headless and deterministic.

## 10. Audio strategy

The long-term plan is for the extension to own audio playback even for Windows Natural synthesis.

Reasons:

- one consistent browser-side volume/rate control surface;
- media-clock-driven highlighting;
- tab audio arbitration stays in one place;
- browser Stop/Quit can deterministically tear down playback;
- native synthesis and browser playback become independently testable.

The proof-of-concept established valid WAV output and SAPI word progress timing. Later gates should reuse those primitives rather than allowing SAPI to play directly to the system audio device.

## 11. Highlighting model

The existing reader uses DOM segment positions and browser-side highlighting. Windows Natural should feed it timing evidence, not replace it.

Expected flow:

```text
reader segments text
    -> native synth request
        -> SAPI SpeakProgress boundaries
        -> WAV/audio bytes
    -> browser maps native offsets to reader segments
    -> media playback begins
    -> media currentTime drives highlight advancement
```

Do not tie visual progress directly to wall-clock timers when a media clock is available.

## 12. Cancellation model

Cancellation must be backend-specific.

A key risk from the first failed integration was reusing inherited state flags such as `directSessionMode` across distinct backends. Windows Natural and Online Natural may share browser playback machinery later, but they must not share ambiguous ownership flags that cause one backend's `cancel()` to interfere with another.

Prefer explicit backend/session ownership:

```text
backend: online-natural | windows-natural | windows-legacy
requestId
sessionId
playback generation
```

Stop/Quit should cancel only the active backend/session and then clear browser playback state.

## 13. Failure containment

The following failures must degrade locally:

```text
Native host not installed
Native host unauthorized for this extension ID
Helper executable missing
Adapter missing
Compatible voice missing
Native request timeout
Malformed native response
Synthesis failure
Cancellation race
```

None may make the reader bootstrap unusable.

The UI should report the unavailable backend while preserving the remaining voice families.

## 14. Development/stable topology

The repository intentionally separates consumption from experimentation:

```text
stable worktree
  -> primary Edge profile
  -> browser-verified reader

development worktree
  -> development Edge profile
  -> Native Messaging experiments
```

Promotion to stable occurs only after the exact candidate commit passes manual browser acceptance.

A green unit test suite is not proof that an unpacked browser extension works.

## 15. Gate progression

The integration is deliberately staged:

```text
Gate 0: preserve known-good reader
Gate 1: native transport + enumeration only
Gate 2: catalog visibility only
Gate 3: isolated Windows Natural playback
Gate 4: highlighting + live controls + warm reuse
Gate 5: promotion candidate
```

Each gate is a compatibility firewall. Do not combine future gates because implementation looks easy in isolation.

## 15.1 Gate 2 catalog-only decisions

Gate 2 represents each native voice as a catalog object with the actual token
preserved separately from its logical identity:

```text
__edgeTtsSource: "win-natural"
nativeVoiceId: "Local-NarratorVoices"   # runtime data, never rewritten
catalogOnly: true
name: "Microsoft Aria"
lang: "en-US"
```

Native enumeration is requested asynchronously through the existing single
background runtime dispatcher. It is not awaited by reader startup. A native
failure returns an empty catalog and leaves the existing Online Natural and
Windows Legacy paths unchanged. Gate 2 UI entries are visibly labeled
`[WIN-NATURAL]` and disabled; stale saved settings cannot select them, and a
defense-in-depth playback guard rejects them until Gate 3.

## 15.2 Gate 3 isolated playback candidate

The Gate 3 candidate adds `win-natural-speech-engine.js` after the existing
Windows Legacy/local engine. It intercepts only `__edgeTtsSource:
"win-natural"`; Online Natural and Windows Legacy continue through the
existing engine chain unchanged.

The helper resolves the exact enabled `Local-*` ID through
`GetInstalledVoices()`, selects its associated display name, and verifies
`SpeechSynthesizer.Voice.Id` matches the requested ID before synthesizing.
It writes WAV data to memory only; the helper never uses a native audio device.

Because Edge limits a Native Messaging host response to 1 MB, WAV data uses
correlated `synth-start`, `synth-chunk`, and `synth-end` frames. The helper
uses 48 KiB binary chunks (about 64 KiB base64), leaving substantial margin
below 1 MB. The browser requires contiguous chunk indexes and exact declared
byte/chunk totals before resolving the request; the complete response is
bounded at 8 MiB and malformed, missing, duplicate, or out-of-order frames
reject cleanly.

The extension owns playback: it decodes the complete WAV, creates an object
URL and HTML audio element after synchronous gesture preparation, and revokes
the URL on completion, cancellation, voice switch, Stop, or Quit. Generation
and request checks discard late synthesis responses. Native synthesis has no
network dependency and no word-boundary/highlighting behavior in Gate 3.

Browser acceptance remains pending. Required checks include Aria playback
with network disabled, Windows Legacy and Online regression playback, Stop,
Quit, voice switching, and native-helper error containment.

## 16. Architectural lessons already paid for

The current design is intentionally conservative because the project has already observed all of these failures in practice:

- optional native discovery blocking reader startup;
- browser reload/lifecycle complexity masking real failures;
- a second runtime message listener interfering with previously working behavior;
- fresh Edge profiles exposing media user-activation bugs in Online Natural playback;
- direct and Edge-launched native processes seeing different adapter registry state;
- unstable adapter-generated token IDs;
- browser automation/tests being insufficient substitutes for real Edge QA.

Those are not hypothetical concerns. The architecture should encode the lessons permanently.
