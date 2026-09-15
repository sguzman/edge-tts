# Windows Natural voice dossier

This directory is the canonical technical record for the optional Windows Natural voice backend in `edge-tts`.

It exists because getting a modern Microsoft Natural voice to behave like a local, offline-capable, browser-consumable TTS backend on Windows was far harder than the final architecture suggests. The difficult parts were not only synthesis. They included Store package compatibility, adapter behavior, SAPI enumeration, browser Native Messaging, Edge process-launch behavior, per-user registry visibility, voice identity instability, extension lifecycle isolation, and preserving an already-working online reader while all of that was being investigated.

The purpose of this dossier is twofold:

1. make the setup reproducible without repeating the original investigation; and
2. preserve the forensic history so future maintainers can distinguish required machinery from dead ends, temporary experiments, browser-specific pathology, and operational mistakes.

## Read this first

- [`SETUP.md`](SETUP.md) — reproducible setup from prerequisites through a browser-visible local Natural voice.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — voice classes, process boundaries, Native Messaging protocol, lifecycle rules, and invariants.
- [`FORENSICS.md`](FORENSICS.md) — what failed, what was tested, what was falsified, and why the integration architecture looks the way it does.
- [`POSTMORTEM_2026-09-15.md`](POSTMORTEM_2026-09-15.md) — Gate 5 promotion, stable Native Messaging deployment failure, installer-origin bug, failed logging attempts, isolated-profile evidence, workspace disruption, and the resulting production-safety rules.
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

Gate 5 code promotion is complete. Stable and development were promoted to:

```text
792fa64553546844c6ce109bf9243b848910e20b
```

The previous stable rollback point is:

```text
c089d08ece6009592faa2fdf4306e4ce873e4ea8
```

The accepted Gate 5 code passed fresh-page human QA for Windows Legacy, Online Natural, WIN-NATURAL Aria, highlighting, live rate/volume, Stop/Play, Quit/same-tab restart, backend switching, latency optimization, and no ghost/overlap audio.

However, **stable WIN-NATURAL deployment is not complete**. After registering the stable extension ID, the stable diagnostics page reports:

```text
Access to the specified native messaging host is forbidden.
```

Direct host `hello` and direct voice enumeration succeed outside Edge, including Microsoft Aria. The on-disk Native Messaging manifest contains both stable and development origins, yet the real stable Edge profile still reports authorization failure. A disposable Edge profile preserving the same stable extension ID currently fails differently with `Native Messaging request timed out: hello` rather than reproducing `forbidden`.

The full chronology, including the installer `allowed_origins` overwrite defect, failed hypotheses, failed logging attempts, workspace disruption, and the production-safety rules created by the incident, is in [`POSTMORTEM_2026-09-15.md`](POSTMORTEM_2026-09-15.md).

Pause/resume position fidelity remains a separate deferred limitation and must not be mixed into the unresolved stable deployment problem.

## The short version of the hard part

A direct PowerShell-launched helper could see the adapter's per-user registry configuration and enumerate `Microsoft Aria`. The same executable, launched by Edge Native Messaging under the same Windows user SID, medium integrity, and x64 architecture, could not see the adapter's `HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator` configuration at all. Both managed registry APIs and raw `RegOpenKeyEx` calls reported the exact adapter key as missing inside the Edge-launched helper, even though the key existed simultaneously and was readable from PowerShell.

Changing Edge's native-host launch mode from `cmd.exe` intermediary to direct `msedge.exe -> WinNaturalHost.exe` did **not** fix the registry visibility problem.

The reliable solution was to stop depending on that registry configuration for Narrator package discovery. `NaturalVoiceSAPIAdapter` has a filesystem default directory named `NarratorVoices` beside the x64 adapter DLL. A reversible directory junction from that default location to the already-working extracted Aria v2 package made the voice visible to the Edge-launched helper even though the registry remained invisible. That solution also continued to work after the temporary Edge direct-launch policy was removed.

That distinction matters: the final local voice discovery setup is not an Edge-policy hack. It is a registry-independent adapter discovery path.

## Reference compatibility state

The verified proof-of-concept and integration work used:

- Windows 11 x64;
- x64 `NaturalVoiceSAPIAdapter` v0.2.4;
- a compatible extracted Aria v2 package from the older package generation used by the adapter;
- current Microsoft Store Aria left installed and untouched;
- .NET Windows Desktop runtime capable of running the x64 helper;
- Edge Manifest V3 extension with `nativeMessaging` permission;
- per-user Edge Native Messaging host registration;
- separate stable and development Edge profiles/worktrees during integration.

The Store voice package was not replaced or downgraded. The compatible extracted package is an external prerequisite and is not committed to this repository.

## Project invariants

The following rules are not optional implementation preferences:

- Windows Natural discovery must never block reader startup.
- Native-host absence or failure must never take down Online Natural or Windows Legacy playback.
- Heavy/native work must not run on the UI/render path.
- The persistent helper owns native synthesis work; the extension owns browser playback and presentation.
- The actual adapter token ID is transport data, not canonical product identity.
- Automated tests are necessary but cannot substitute for Edge runtime verification.
- Browser acceptance after extension reload/source changes must use a genuinely fresh page.
- Stable code/worktree and the user's real stable Edge profile are production state.
- Experimental browser manipulation belongs in development or a disposable `--user-data-dir`, not in the live stable reading workspace.
- A browser process relaunch is not proof that the user's workspace was restored.
- Stable WIN-NATURAL deployment is not complete until the stable diagnostics page connects, enumerates Microsoft Aria, and the stable reader audibly uses it.

## Updating this dossier

Every later gate or incident should add four kinds of information here:

1. **what changed architecturally**;
2. **what exact browser behavior was manually observed**;
3. **what rollback/restoration path exists**; and
4. **what tempting but incorrect explanation was ruled out**.

For incidents, also preserve the failed attempts and any operational damage or near-miss caused by the investigation itself. Dead ends are project knowledge, not disposable chat history.

This project already paid the cost of discovering these failure modes once. The documentation should ensure nobody has to pay it again.
