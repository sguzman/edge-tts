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
