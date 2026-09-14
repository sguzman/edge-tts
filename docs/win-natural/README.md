# Windows Natural voice dossier

This directory is the canonical technical record for the optional Windows Natural voice backend in `edge-tts`.

It exists because getting a modern Microsoft Natural voice to behave like a local, offline-capable, browser-consumable TTS backend on Windows was far harder than the final architecture suggests. The difficult parts were not only synthesis. They included Store package compatibility, adapter behavior, SAPI enumeration, browser Native Messaging, Edge process-launch behavior, per-user registry visibility, voice identity instability, extension lifecycle isolation, and preserving an already-working online reader while all of that was being investigated.

The purpose of this dossier is twofold:

1. make the setup reproducible without repeating the original investigation; and
2. preserve the forensic history so future maintainers can distinguish required machinery from dead ends, temporary experiments, and browser-specific pathology.

## Read this first

- [`SETUP.md`](SETUP.md) — reproducible setup from prerequisites through a browser-visible local Natural voice.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — voice classes, process boundaries, Native Messaging protocol, lifecycle rules, and invariants.
- [`FORENSICS.md`](FORENSICS.md) — what failed, what was tested, what was falsified, and why the final solution looks the way it does.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — symptom-driven diagnosis and recovery commands.
- [`VERIFICATION.md`](VERIFICATION.md) — gate-by-gate acceptance matrix and the exact behaviors that were manually verified.
- [`../WIN_NATURAL_V2_PLAN.md`](../WIN_NATURAL_V2_PLAN.md) — staged reintegration plan used to keep experimental native work from breaking the load-bearing reader.

The native helper also has a compact implementation-oriented README at [`../../native/win-natural/README.md`](../../native/win-natural/README.md). That file is intentionally shorter; this directory is the historical and operational source of truth.

## Voice taxonomy

The project treats three classes of voice as different backends even when Microsoft uses similar product names:

- **Windows Legacy** — classic Windows voices such as David, Mark, and Zira exposed through Windows/Web Speech/`chrome.tts` mechanisms.
- **Windows Natural** — a locally available Narrator Natural package exposed through `NaturalVoiceSAPIAdapter`, then through this project's x64 Native Messaging helper. The verified reference voice is `Microsoft Aria`.
- **Online Natural** — Microsoft Edge/Read Aloud/Azure-style Natural voices reached over the existing online direct-MP3 transport.

These classes must never be collapsed merely because they share names such as "Aria". They have different availability, latency, failure modes, process boundaries, and offline characteristics.

## Current state

As of the completion of Gate 1 on the `development/win-natural-v2` line:

- the existing Windows Legacy reader still works;
- the existing Online Natural direct-MP3 reader still works, including repeated playback after pause/stop;
- Edge Native Messaging connects to a persistent x64 helper;
- the helper can enumerate the local adapter-backed `Microsoft Aria` voice;
- the actual SAPI token observed through the working registry-independent discovery path is `Local-NarratorVoices`;
- the logical identity is therefore **not** the literal token ID. The code must preserve the real token ID for later synthesis while matching the logical voice by `Local-*` adapter identity + `Microsoft Aria` + language;
- no Edge enterprise policy is required for the working solution;
- the stable reader remains isolated on the `stable` branch/worktree and is not modified during development.

Gate 3C is accepted on fresh-page browser QA. Gate 4A, Gate 4B, and Gate 4C
are accepted. Gate 5 has not started. The next planned engineering goal is
WIN-NATURAL startup/synthesis latency investigation; pause/resume position
fidelity remains a separate deferred limitation.

## The short version of the hard part

A direct PowerShell-launched helper could see the adapter's per-user registry configuration and enumerate `Microsoft Aria`. The same executable, launched by Edge Native Messaging under the same Windows user SID, medium integrity, and x64 architecture, could not see the adapter's `HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator` configuration at all. Both managed registry APIs and raw `RegOpenKeyEx` calls reported the exact adapter key as missing inside the Edge-launched helper, even though the key existed simultaneously and was readable from PowerShell.

Changing Edge's native-host launch mode from `cmd.exe` intermediary to direct `msedge.exe -> WinNaturalHost.exe` did **not** fix the registry visibility problem.

The reliable solution was to stop depending on that registry configuration for Narrator package discovery. `NaturalVoiceSAPIAdapter` has a filesystem default directory named `NarratorVoices` beside the x64 adapter DLL. A reversible directory junction from that default location to the already-working extracted Aria v2 package made the voice visible to the Edge-launched helper even though the registry remained invisible. That solution also continued to work after the temporary Edge direct-launch policy was removed.

That distinction matters: the final setup is not an Edge-policy hack. It is a registry-independent adapter discovery path.

## Reference compatibility state

The verified proof-of-concept and Gate 1 work used:

- Windows 11 x64;
- x64 `NaturalVoiceSAPIAdapter` v0.2.4;
- a compatible extracted Aria v2 package from the older package generation used by the adapter;
- current Microsoft Store Aria left installed and untouched;
- .NET Windows Desktop runtime capable of running the x64 helper;
- Edge Manifest V3 extension with `nativeMessaging` permission;
- per-user Edge Native Messaging host registration;
- a dedicated development Edge profile and unpacked extension ID during integration.

The Store voice package was not replaced or downgraded. The compatible extracted package is an external prerequisite and is not committed to this repository.

## Project invariants

The following rules are not optional implementation preferences:

- Windows Natural discovery must never block reader startup.
- Native-host absence or failure must never take down Online Natural or Windows Legacy playback.
- Heavy/native work must not run on the UI/render path.
- The persistent helper owns native synthesis work; the extension owns browser playback and presentation.
- The actual adapter token ID is transport data, not canonical product identity.
- Stable remains a separately loaded, browser-verified runtime. Experimental integration happens on development branches/worktrees and is promoted only after explicit manual browser acceptance.
- Automated tests are necessary but cannot substitute for Edge runtime verification.

Gate 3C deliberately leaves three limitations for Gate 4/backlog: native
startup/synthesis latency, native word/sentence highlight synchronization, and
intra-sentence Pause/Resume position fidelity.

## Updating this dossier

Every later gate should add four kinds of information here:

1. **what changed architecturally**;
2. **what exact browser behavior was manually observed**;
3. **what rollback path exists**; and
4. **what tempting but incorrect explanation was ruled out**.

This project already paid the cost of discovering these failure modes once. The documentation should ensure nobody has to pay it again.
