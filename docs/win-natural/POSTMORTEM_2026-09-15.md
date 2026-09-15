# Windows Natural integration postmortem — 2026-09-15

This document preserves the post-Gate-5 deployment incident and the operational mistakes made while diagnosing it. It is intentionally detailed. The earlier integration history is already recorded in [`FORENSICS.md`](FORENSICS.md), including the failed monolithic Gate 3, the Gate 3A/3B/3C decomposition, timing work, live controls, latency optimization, and the Gate 5 Online Natural regression/correction.

The purpose of this file is to make sure the project never has to rediscover either the technical facts or the operational lessons from this incident.

## Status at the start of this incident

Gate 5 code promotion had completed successfully.

Accepted/promotion state:

```text
stable HEAD:      792fa64553546844c6ce109bf9243b848910e20b
development HEAD: 792fa64553546844c6ce109bf9243b848910e20b
rollback stable:  c089d08ece6009592faa2fdf4306e4ce873e4ea8
```

The final Gate 5 browser matrix had passed on fresh pages:

```text
WIN-NATURAL Aria: audible
highlight sync: PASS
live rate: PASS
live volume: PASS
chunk gaps: none observed
Stop -> Play: PASS
Quit -> same-tab restart: PASS
WIN-NATURAL -> Online Aria -> WIN-NATURAL: PASS
no ghost/overlap audio: PASS
```

The earlier Online Natural promotion blocker had been corrected narrowly by removing hot-path per-frame console logging while preserving the 12-second timeout and transport semantics. The corrected candidate `360460a99a0b52cc5d45fa3c406c84f881f9752c` passed fresh-page human QA before promotion.

At that point the **code** was accepted. The remaining job was to make the stable Edge extension ID authorized to use the installed Native Messaging host.

## Stable and development extension identities

These identities are load-bearing and must not be confused:

```text
Stable extension ID:
gfeeggciegdnlpdmebfjmahboogkilhi

Stable source path:
C:\Users\guzma\Documents\GitHub\edge-tts

Stable Edge profile:
Default

Development extension ID:
gajodjkpikfgfbcobncfacbjeaekgefb

Development source path:
C:\Users\guzma\Documents\GitHub\edge-tts-dev

Development Edge profile:
Profile 1
```

## Stable Native Messaging registration attempt

The stable host registration was performed using:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\win-natural\install-native-host.ps1 -ExtensionId "gfeeggciegdnlpdmebfjmahboogkilhi"
```

The installed host manifest was:

```text
C:\Users\guzma\AppData\Local\EdgeNaturalTts\native-host\com.sguzman.edge_tts.win_natural.json
```

The registry registration was:

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural
```

The helper executable was:

```text
C:\Users\guzma\Documents\GitHub\edge-tts\native\win-natural\bin\Release\net10.0-windows\win-x64\publish\WinNaturalHost.exe
```

### Installer defect discovered

The installer did **not** merge `allowed_origins`. It replaced the array.

That meant registering the stable extension temporarily removed the development extension origin from the shared host manifest. The development origin had to be restored alongside stable.

The intended final authorization list was:

```text
chrome-extension://gfeeggciegdnlpdmebfjmahboogkilhi/
chrome-extension://gajodjkpikfgfbcobncfacbjeaekgefb/
```

The installer defect was later corrected on the development branch in:

```text
071328c5 Preserve existing Native Messaging origins
```

The correction makes installation merge/preserve valid origins and avoid duplicates instead of replacing the entire list. Tests increased to 147 and passed, along with syntax checks and `git diff --check`.

**Important:** the installer bug was real, but fixing it did not by itself explain the stable browser authorization failure described below.

## First stable deployment failure

After stable registration, the stable extension UI showed:

```text
Voice class: Windows Natural
Voice: No matching voices
```

So Local Aria was **not actually usable in stable**, even though the Gate 5 code had been promoted.

This established an important state distinction:

```text
Gate 5 code promotion: COMPLETE
Stable WIN-NATURAL deployment: NOT COMPLETE
```

The browser-side voice discovery path flattened Native Messaging enumeration failure into an empty voice list, so `No matching voices` did not identify the actual cause.

## Direct native-host diagnosis

Machine-side checks were then performed without relying on Edge.

The registration and helper were found to be healthy:

```text
registry key: present
manifest path: correct
host executable: present
architecture: x64
conflicting HKLM registration: absent
stable origin: present exactly once
development origin: present exactly once
```

Direct Native Messaging framing/protocol probes succeeded:

```json
{"type":"hello","protocol":1,"architecture":"x64"}
```

Direct voice enumeration also succeeded:

```json
{"id":"Local-aria-v2","name":"Microsoft Aria","lang":"en-US"}
```

This proved:

- SAPI was functioning;
- the helper executable was functioning;
- the helper could enumerate Microsoft Aria;
- registry lookup of the host manifest was functioning outside the browser authorization path;
- the failure had moved upward into Edge/extension authorization or browser state.

## Stable diagnostics revealed the real browser error

The stable diagnostic page was opened at:

```text
chrome-extension://gfeeggciegdnlpdmebfjmahboogkilhi/diagnostics/win-natural.html
```

It reported:

```text
Connection failed
Access to the specified native messaging host is forbidden.
```

This was a major improvement over `No matching voices`: Edge knew about the host name but rejected the caller as unauthorized.

The failure was therefore not ordinary SAPI enumeration, synthesis, or helper startup.

## Stale authorization cache hypothesis

A plausible hypothesis was that Edge had started before the stable origin was restored to `allowed_origins`, and had cached the earlier unauthorized manifest state.

Evidence at the time:

- Edge processes had started at approximately 05:47;
- the corrected manifest had been written at approximately 06:57.

A full Edge exit/restart was attempted.

Result:

```text
stable diagnostics still reported:
Access to the specified native messaging host is forbidden.
```

Therefore the stale-cache explanation was **not sufficient** and could not be retained as the root cause.

## Read-only forensic comparison

A read-only comparison then established:

```text
Stable profile: Default
Stable extension ID: gfeeggciegdnlpdmebfjmahboogkilhi
Stable source: C:\Users\guzma\Documents\GitHub\edge-tts

Development profile: Profile 1
Development extension ID: gajodjkpikfgfbcobncfacbjeaekgefb
Development source: C:\Users\guzma\Documents\GitHub\edge-tts-dev
```

Both extensions were:

```text
unpacked
enabled
version 0.4.1
nativeMessaging permission active
```

Additional findings:

- no relevant Edge policy keys existed;
- no duplicate host manifest was found;
- no conflicting HKLM host registration existed;
- HKCU registry views pointed to the same manifest;
- manifest bytes were valid UTF-8 JSON;
- no BOM or hidden origin characters were found;
- host name and background constant matched exactly;
- both origins were present in the manifest.

The browser's `forbidden` error path was identified as an authorization failure associated with the caller not being accepted against parsed `allowed_origins`, distinct from ordinary host-launch/protocol failure.

That left a contradiction:

```text
manifest bytes on disk authorize stable
Edge stable profile says stable is forbidden
```

The exact mechanism remained unresolved.

## First isolated logging attempt

A disposable Edge user-data directory was created to avoid disturbing the live stable profile.

Command shape:

```text
--user-data-dir=<temporary directory>
--disable-extensions-except=C:\Users\guzma\Documents\GitHub\edge-tts
--load-extension=C:\Users\guzma\Documents\GitHub\edge-tts
--enable-logging
--log-level=0
--vmodule=native_messaging*=2,extensions*=2
--log-file=<temporary profile>\edge.log
```

Crucially, the isolated run preserved the exact stable extension ID:

```text
gfeeggciegdnlpdmebfjmahboogkilhi
```

That proved the stable ID can be reproduced in a disposable profile without touching the user's real browser profile.

However, this first isolated run failed to exercise the diagnostics connection in a way that emitted useful Native Messaging authorization evidence. No host authorization decision was captured.

### Lesson

The correct response to a failed isolated experiment should have been to improve the isolated harness, **not** to escalate immediately to the live stable Edge profile.

## Operational failure: live stable Edge was used as a diagnostic surface

The investigation then made the most expensive mistake of this incident: it treated the user's production Edge workspace as a fallback test environment.

The live stable profile was actively used for reading and contained multiple windows. A temporary logging run was attempted against it.

### Two-window topology was not accounted for first

There were two visible Edge windows, both under the same `Default` profile and the same browser process tree.

Observed inventory:

```text
visible top-level Edge windows: 2
both profile: Stable Default
both browser PID: same root Edge process
development profile: not active
```

Closing only one window could not produce a clean new browser instance because the second window kept the shared browser process alive.

This topology should have been checked **before any close/relaunch instructions were given**.

### The logging run failed anyway

The real-profile logging launch attempted to open the stable diagnostics URL, but Edge session restore brought back the prior YouTube window instead.

Result:

```text
diagnostics page not reached
no stable Native Messaging attempt captured
no useful authorization log produced
```

Worse, only one of the user's two original windows came back afterward. The environment was therefore **not restored**, even though the process had been relaunched without logging flags.

This distinction matters:

```text
browser process relaunched normally != user workspace restored
```

The project must never again equate those two claims.

### Recovery shortcut was also unsuitable

Using `Ctrl+Shift+T` as a workspace/window recovery plan had already been identified by the user as unreliable and must not be treated as deterministic restoration.

### Permanent operating rule created by this failure

> The real stable Edge workspace is production state, not a test harness.

No future diagnostic should close, restart, reload, kill, or mutate the real stable Edge environment unless the user explicitly lifts this boundary and there is a deterministic restoration plan for **every** open window and relevant state.

## Correct architecture: isolated Edge test harness

The investigation returned to the architecture that should have been used all along: a disposable Edge user-data directory alongside the real browser, not inside it.

A fresh isolated profile was created at:

```text
C:\Users\guzma\AppData\Local\Temp\edge-win-natural-isolated-20260915-085906017
```

The stable source was loaded directly:

```text
C:\Users\guzma\Documents\GitHub\edge-tts
```

Observed isolated extension ID:

```text
gfeeggciegdnlpdmebfjmahboogkilhi
```

The diagnostics page successfully opened and was independently verified.

### Isolated result

The isolated diagnostic did **not** reproduce `forbidden`.

Instead it reported:

```text
Connection failed
Loading voices…
Native Messaging request timed out: hello
```

The isolated log contained no useful authorization lines for the project host.

The isolated Edge process was then closed. The original real Edge root process remained running before and after with the same normal command line. No real window/profile was closed, restarted, or reloaded during this isolated run.

No registry, manifest, source, policy, shortcut, or extension-registration state was changed.

The isolated directory/log was deliberately preserved for further forensic use.

## Current discrepancy

The strongest current evidence is the difference between the two browser environments:

```text
REAL DEFAULT PROFILE:
Access to the specified native messaging host is forbidden.

ISOLATED PROFILE WITH THE SAME EXTENSION ID:
Native Messaging request timed out: hello.
```

This discrepancy is now the primary object of investigation.

The next safe investigation should compare relevant extension/profile metadata read-only and trace exactly where the isolated `hello` stalls:

```text
diagnostics page
-> runtime message
-> background/service worker
-> NativeMessagingTransport
-> chrome.runtime.connectNative
-> native port
-> helper launch
-> hello write
-> hello response
```

The real stable Edge environment is not required for that work and must remain untouched.

## What has been proven

| Claim | Status |
| --- | --- |
| Gate 5 code passed human browser QA before promotion | proven |
| Stable and development were promoted to `792fa645...` | proven |
| Native helper executable exists and runs x64 | proven |
| Direct helper `hello` works | proven |
| Direct helper voice enumeration returns Microsoft Aria | proven |
| Shared Edge Native Messaging registry entry exists | proven |
| On-disk manifest contains stable origin | proven |
| On-disk manifest contains development origin | proven |
| No conflicting HKLM host registration found | proven |
| Stable extension runtime ID is `gfeeggc...` | proven |
| Stable profile has `nativeMessaging` permission | proven |
| Full browser restart fixes stable authorization | disproven |
| `No matching voices` means SAPI cannot see Aria | disproven |
| Real stable profile reports host authorization failure | proven |
| Disposable profile can preserve exact stable extension ID | proven |
| Disposable profile currently reproduces the same `forbidden` result | disproven; it currently times out on `hello` instead |
| Stable WIN-NATURAL deployment is complete | false |

## Working solutions that should be preserved

The incident contains several fixes that are valid even though the final stable deployment issue remains unresolved.

### Gate 5 Online Natural correction

Do not restore per-frame WebSocket console logging in the hot path. Keep bounded phase logging and one turn-end summary. The 12-second timeout and direct-audio protocol semantics were intentionally left unchanged.

### Installer origin merge

Native host installation must merge/preserve `allowed_origins` rather than replace them. Re-running the installer for one extension ID must not silently deauthorize another installed development/stable extension.

### Stable/development identity separation

Treat the stable and development extension IDs, source paths, and Edge profiles as independent deployment identities. Never infer one from the other.

### Fresh-page browser acceptance

After extension reload/source candidate changes, human QA must use a genuinely fresh page. Existing injected tabs can retain stale runtime state and produce false conclusions.

### Isolated browser diagnostics

When browser launch flags, Native Messaging logs, profile experiments, or extension installation state must be manipulated, use a dedicated `--user-data-dir` and preserve the exact extension ID if the experiment depends on authorization identity.

## What must never be repeated

The following are now explicit anti-patterns:

- do not use the user's live stable Edge profile as a convenient fallback test harness;
- do not close/restart stable merely because an isolated test is incomplete;
- do not assume a browser process restart restored the user's workspace;
- do not use unreliable recently-closed-window restoration as a rollback plan;
- do not issue close/relaunch instructions before establishing the number of windows and process/profile topology;
- do not perform standalone safety/preflight turns that produce no new technical evidence when the same checks can be embedded in the actual experiment;
- do not turn every uncertainty into another user-visible manual QA step;
- do not flatten machine registration success, browser authorization, voice enumeration, and UI catalog population into one concept called "working";
- do not declare deployment complete until the **stable diagnostics page connects and enumerates Microsoft Aria** and the stable reader can select and audibly use it;
- do not let an installer overwrite shared authorization state;
- do not test experimental fixes in stable.

## Production boundary

From this incident forward:

```text
Stable code/worktree: production
Stable Edge Default profile: production
User's live Edge workspace: production state
Development worktree/profile: experimental
Disposable --user-data-dir: diagnostic/test harness
```

Experimental uncertainty belongs on development or in a disposable browser profile.

If an experiment cannot be made safe in those environments, redesign the experiment. Do not use the production browser session as the default escape hatch.

## Documentation rule created by this project

For every future significant investigation, preserve:

1. the exact user-visible failure;
2. the exact source/profile/extension identity involved;
3. the hypothesis;
4. the experiment used to discriminate it;
5. what the experiment actually observed;
6. what was ruled out;
7. what changed, if anything;
8. the causal fix when known;
9. the rollback/restoration procedure;
10. the exact human browser acceptance result;
11. any operational damage or near-miss caused by the investigation itself.

Failures and dead ends are first-class project knowledge. A failed experiment that eliminates a hypothesis is part of the implementation history and must not disappear merely because the final code is clean.

## Current unresolved item

As of this postmortem, the final stable authorization issue is **not solved**.

Do not rewrite this history later to imply a smooth deployment. Append the eventual root cause and final stable fix when it is proven, including the final stable diagnostic output and audible stable-reader acceptance.
