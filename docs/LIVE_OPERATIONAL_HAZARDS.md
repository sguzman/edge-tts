# Live operational hazards

`edge-tts` is not just a repository. It is a load-bearing reading system attached to a live Edge installation, browser profiles, extension identities, Windows processes, Native Messaging registration, Microsoft speech infrastructure, account state, external voice assets, several playback transports, and a user-visible stable runtime.

Any agent working on this project must treat those live surfaces as production infrastructure.

This document exists because the Windows Natural work exposed a structural fact that is easy to miss from the source tree: **a reasonable product requirement — use a high-quality Microsoft Natural voice locally — crosses an unusually large number of partially sovereign systems.** Each system owns part of the result, exposes only some of its internal state, and can reject or reinterpret requests independently. The resulting failure surface is much larger than the apparent feature surface.

This should not be this difficult. It is. Treat that difficulty as an architectural fact, not as a temporary inconvenience.

The first version of this document was written after the 2026-09-15 WIN-NATURAL rollout/diagnosis, when the coordinating assistant repeatedly treated live browser state as ordinary debugging substrate, disrupted progress, and created avoidable risk around the user's working reader. It now also serves as the explicit terrain map for the whole system.

---

## 1. Current protected state

This section is a dated operational snapshot, not a timeless architectural guarantee.

- The normal Edge `Default` profile is the user's load-bearing reading environment.
- The stable unpacked extension ID is `gfeeggciegdnlpdmebfjmahboogkilhi` and its source path is `C:\Users\guzma\Documents\GitHub\edge-tts`.
- The development extension ID is `gajodjkpikfgfbcobncfacbjeaekgefb` and its source path is `C:\Users\guzma\Documents\GitHub\edge-tts-dev`.
- Windows Legacy and Online Natural are working reader backends and must not be disturbed while diagnosing WIN-NATURAL.
- Gate 5 source promotion reached stable commit `792fa64553546844c6ce109bf9243b848910e20b`.
- Stable WIN-NATURAL deployment is **not complete**. On the real stable profile, the diagnostics page still reports `Access to the specified native messaging host is forbidden`, and Local Aria is not available to the reader.
- Direct native-host probes do work: `hello` reports protocol 1/x64 and `voices` returns `Local-aria-v2 / Microsoft Aria / en-US`. That proves host/SAPI health, not browser authorization.

Do not call WIN-NATURAL stable until the stable diagnostics page itself connects and enumerates Microsoft Aria and the stable reader can actually use it.

---

## 2. Why this terrain is unusually treacherous

The main hazard is not simply "there are many components." The deeper problem is **high sovereign-boundary density**.

A sovereign boundary is a point where another subsystem has independent authority over whether an operation is allowed, what state is visible, what timing rules apply, or what result is returned. The caller cannot simply reason from repository source and assume the downstream system shares the same state model.

For local Natural playback, the conceptual path is approximately:

```text
page DOM / text model
  -> reader / batch scheduler
  -> WIN-NATURAL engine
  -> extension background/service worker
  -> Edge Native Messaging authorization
  -> Windows Native Messaging registry lookup
  -> native-host manifest + allowed_origins
  -> WinNaturalHost.exe
  -> .NET runtime / process architecture
  -> x64 SAPI
  -> NaturalVoiceSAPIAdapter
  -> adapter registry/configuration
  -> extracted Natural voice assets
  -> Microsoft Aria synthesis
  -> PCM/WAV + SAPI word boundaries
  -> Native Messaging framing
  -> extension reconstruction
  -> browser media object
  -> autoplay/user-activation policy
  -> HTMLMediaElement playback clock
  -> Web Audio gain
  -> timing map
  -> model token / DOM range mapping
  -> CSS Custom Highlight state
  -> auto-scroll / click-to-seek / controls
  -> human perception of sound + synchronization
```

The Online Natural path and Windows Legacy path take different routes through the middle while rejoining the same reader/UI state. Therefore a single toolbar is presenting several distinct execution systems as if they were one coherent speech engine.

The project must never assume that a failure in the user-visible reader originates near the user-visible symptom.

---

## 3. Sovereignty and moving-surface map

The table below is the canonical inventory of important operational surfaces. It intentionally includes systems outside the repository.

| Surface | What it owns | Hidden/independent state | Representative failure | What actually proves it healthy |
|---|---|---|---|---|
| Host page DOM | Text nodes, layout, application lifecycle | SPA mutations, editor/framework behavior | stale text model, wrong seek/highlight target | reader builds correct model on the real page |
| Content-script reader | Cursor, batches, toolbar, local session | injected-version lifetime, tab-local state | old injected code survives extension reload; wrong cursor state | fresh injection behaves correctly in target tab |
| Text model | Spoken text ↔ DOM mappings | offsets depend on current DOM snapshot | correct audio highlights wrong text | word/sentence ranges match the current model |
| Highlighter | CSS Custom Highlight names/ranges | global names inside a document | dev cleanup removes stable highlights | correct channel owns only its own highlight state |
| Toolbar/HUD | User controls and displayed state | DOM identifiers can collide | dev and stable remove/overwrite each other's UI | channel-isolated UI survives simultaneous document state |
| Extension background/service worker | privileged routing, Native Messaging, audio ownership | lifecycle/suspension/reload timing | connection logic not running version expected | diagnostics from the active worker prove current code path |
| Extension identity | origin, storage, permissions, Native Messaging authorization | unpacked path determines ID when no fixed key | same source at different path becomes a different principal | exact extension ID/origin recorded and authorized |
| Extension storage/settings | saved voice/rate/UI state | scoped by extension identity/profile | dev appears differently configured from stable | exact profile + extension storage inspected/QA'd |
| Edge profile | extension install state, permissions, runtime history | profile-local state is partly opaque | stable says `forbidden` while dev works | real target profile passes browser-facing diagnostics |
| Edge process tree | browser instance, windows, service processes | several windows may share one root instance | restarting "one window" disrupts all work | process/profile/window ownership established first |
| Edge single-instance routing | decides whether a new launch is new or handed to existing browser | existing profile/process topology | diagnostic flags/URL land in real browser | isolated user-data-dir/process tree verified |
| Account/sync bootstrap | identity and cloud/browser state | can appear in fresh user-data-dir | disposable profile unexpectedly associates with account | test remains explicitly accountless |
| Autoplay/user activation | permission to start media | transient gesture state can expire across async work | valid synthesized audio, `play()` rejected or silent | real browser starts audible playback from intended interaction |
| HTMLMediaElement | decoded media and playback clock | readyState/events/timing | audio exists but never audibly starts | media events + audible QA |
| Web Audio graph | gain/volume stage | context state and browser policy | media plays but gain path is silent/wrong | audible output at expected level |
| Online Read Aloud endpoint | network Natural synthesis | undocumented Microsoft consumer protocol | handshake/service changes, network failure | real request returns valid MP3 + boundaries |
| Online direct-audio engine | MP3 assembly, media playback | WebSocket/media state | timing/audio mismatch | real Online playback + highlighting QA |
| Web Speech / `chrome.tts` | Windows Legacy speech | browser/OS shared speech behavior | cancel/pause interactions across sessions | target legacy voice works end-to-end |
| Browser audio ownership coordinator | arbitration between tab sessions | shared browser/OS speech state | two tabs fight or cancel each other | ownership transitions preserve expected paused/canceled state |
| Native Messaging registry | host-name -> manifest resolution | HKCU machine state outside repo | host not found / wrong manifest resolved | exact Edge registry key resolves intended manifest |
| Native-host manifest | executable path + allowed extension origins | mutable file outside source control | one installer removes other channel's origin | manifest on disk contains exact intended origins/path |
| Native Messaging authorization inside Edge | whether extension origin may connect | Edge's effective interpretation may not be fully observable | `Access ... forbidden` despite apparently correct disk state | connection from the exact target profile/extension succeeds |
| Native Messaging transport | framed stdio messages | framing/size/protocol/lifecycle | timeout, truncated payload, dead helper | browser-host round trip succeeds with protocol diagnostics |
| `WinNaturalHost.exe` | SAPI orchestration and audio packaging | process lifetime, warm/cold state | helper crash/timeout | persistent host answers `hello`, `voices`, synthesis |
| .NET runtime | helper execution | installed runtime version/environment | host cannot launch | target executable runs under intended runtime |
| Process architecture | x64 COM/SAPI visibility | x86/x64 registrations differ | voice visible in one bitness only | helper reports x64 and x64 SAPI sees token |
| SAPI | synthesis interface + `SpeakProgress` | token catalog/COM state | voice token absent, synthesis failure | direct SAPI synthesis succeeds |
| NaturalVoiceSAPIAdapter | exposes Natural assets as SAPI tokens | system-wide registration/config | adapter token missing or wrong voice family | `Local-*` token enumerates/synthesizes in x64 SAPI |
| Adapter configuration | narrator path / voice-source switches | registry/config outside repo | wrong extracted package used or excluded | exact configured path/options recorded and probed |
| Extracted Natural voice package | local neural voice assets | external prerequisite, version-sensitive | token exists but synthesis incompatible/fails | offline synthesis produces valid audio |
| Microsoft Store Natural packages | Microsoft's installed voice state | Windows-managed | accidental modification/upgrade assumptions | remain untouched unless task explicitly targets them |
| Chunk/batch scheduler | bounded synthesis work and progression | request generation/order | latency scales with whole document, stale chunks play | first audio latency bounded; long text advances correctly |
| Request-generation/stale-result guards | validity of async completion | old work may finish after user moves on | technically valid audio plays for obsolete request | stale completion is discarded deterministically |
| Native audio framing | transports WAV payloads | Native Messaging message limits | large audio response fails/truncates | multi-frame synthesis reconstructs valid WAV |
| WAV/PCM packaging | media bytes/format | header/length/format correctness | synthesis "succeeds" but browser cannot decode | RIFF/PCM validates and browser decodes |
| Word-boundary metadata | spoken token times | SAPI/service indexing semantics | highlights drift or jump | boundary stream maps correctly to synthesized text |
| Timing map | source text offsets ↔ media time | punctuation/tokenization transforms | correct sound, wrong word highlighted | timed seek/highlight matches audible word |
| Pause/resume/stop/cancel | lifecycle semantics across layers | synthesis, buffered media, and playback are distinct | stop leaves stale audio; resume restarts wrong place | all controls verified on real backend |
| Speed/rate controls | playback or synthesis speed depending backend | semantics differ by transport | rate change resynthesizes unexpectedly or desyncs timing | live control behaves per backend contract |
| Stable worktree/branch | production source | distinct from development state | agent edits wrong tree | path + branch + commit named before mutation |
| Development worktree/branch | experimental source | can still touch shared OS/browser state | dev installer breaks stable authorization | dev remains disposable without stable repair |
| Repository tests/checks | source-level regressions | cannot see live browser/profile/OS state | all tests pass while stable is broken | useful but never accepted as deployment proof |
| Human QA | end-to-end observable truth | only layer that hears/sees total result | automation declares success while UX fails | explicit real-world acceptance of candidate |
| Coordination/provenance | intent across user -> assistant -> Codex/tools | conversational assumptions can outlive corrections | obsolete instruction implemented correctly | current authoritative goal + constraints stated in task |

If a new subsystem is introduced, add it to this table before treating it as an ordinary implementation detail.

---

## 4. Three independent complexity classes

Do not describe this project merely as "complex." Name the kind of complexity involved.

### 4.1 Computational complexity

Examples:

- chunking long text;
- scheduling synthesis ahead of playback;
- building timing maps;
- discarding stale asynchronous completions;
- reconstructing framed WAV data.

These are often the easiest hazards to own because they live largely in code we control.

### 4.2 Integration complexity

Examples:

- Edge extension -> Native Messaging;
- Native Messaging -> Windows helper;
- helper -> SAPI -> adapter -> Natural voice assets;
- browser media policy -> playback;
- generated timing -> DOM highlighting.

These cross sovereign systems. A locally correct component can be integrated incorrectly.

### 4.3 Operational/provenance complexity

Examples:

- main vs stable source state;
- stable vs dev extension identity;
- stable vs dev browser profile;
- shared HKCU Native Messaging registration;
- service-worker/injected-script version lifetime;
- account state in supposedly disposable browser instances;
- user QA vs automated evidence;
- old prompts/assumptions surviving after requirements change.

This category caused some of the most dangerous failures because it is not represented by the repository dependency graph.

---

## 5. Evidence hierarchy: success at one layer does not promote itself

The following implications are **invalid unless separately proven**:

```text
source compiles/tests pass
  != native helper works

native helper works
  != Edge can connect to it

manifest/registry look correct
  != Edge authorizes the extension

dev profile works
  != stable profile works

same code
  != same extension identity

same extension source
  != same injected code already running in an existing tab

fresh user-data-dir
  != identity/account isolation

synthesis returns valid audio bytes
  != browser is permitted to play them

HTMLMediaElement.play() was attempted
  != the user heard sound

word-boundary events exist
  != boundaries map to the right DOM text

highlight moves
  != highlight is synchronized with audible speech

one visible Edge window closed
  != Edge process/profile state was restarted

repo/worktree isolation
  != OS registration isolation

dev extension isolation
  != shared Native Messaging/adapter isolation

automated test success
  != stable deployment success

"works in Edge"
  != works in the exact stable profile, extension ID, install mode, and backend under discussion
```

Every diagnostic claim should therefore name its layer. Prefer statements such as:

- "direct x64 helper synthesis succeeds";
- "dev profile Native Messaging authorization succeeds";
- "stable profile Native Messaging authorization fails";
- "Online audio was generated but browser playback was rejected";

instead of "Aria works" or "the extension is broken."

---

## 6. Known high-value successes — do not destroy these while debugging adjacent layers

The Windows Natural work proved that several difficult pieces are actually sound and valuable:

- A local Microsoft Aria path can synthesize through x64 SAPI/NaturalVoiceSAPIAdapter without network access.
- The persistent helper removes most process-startup penalty; warm short-utterance synthesis can be very fast.
- Long-text generation does not need to scale first-play latency with the full document. Bounded chunk/batch generation allows playback to begin while later material is prepared.
- SAPI `SpeakProgress` provides useful word-boundary timing for local Natural audio.
- The browser can consume generated PCM/WAV through the same general media-clock/highlighting architecture used by direct Natural audio.

These wins matter operationally. When a browser/profile authorization failure appears, do not casually rewrite synthesis, chunking, timing, or voice extraction merely because they are upstream of the visible symptom. Preserve proven layers until evidence implicates them.

---

## 7. Symptom-to-surface failure matrix

Use this to avoid debugging the wrong layer first.

| User-visible or diagnostic symptom | Likely surfaces to inspect first | Do **not** conclude yet |
|---|---|---|
| Local Aria missing from catalog | Native Messaging browser connection, helper `voices`, SAPI token visibility, adapter config | that synthesis code is broken |
| `Access to the specified native messaging host is forbidden` | exact extension ID/origin, target profile, manifest `allowed_origins`, Edge effective authorization | that host executable/SAPI is broken |
| `Native Messaging request timed out` | host launch, install context, protocol/framing, process lifetime, manifest path | that it is the same failure as `forbidden` |
| Direct `hello`/`voices` succeeds but reader fails | browser authorization/service worker/extension identity/profile | that machine-side helper success proves browser deployment |
| Valid WAV generated but no sound | autoplay/user activation, media element, Web Audio/context state, stale request ownership | that Aria/SAPI failed |
| Dev profile works, stable fails | profile/install identity, authorization, injected/service-worker state, shared external registration | that source is different unless verified |
| Stable works until dev host install | shared Native Messaging manifest/registration and origin merge behavior | that stable code regressed |
| Voice starts after noticeable delay on huge text | batch/chunk scheduling, startup path | that model synthesis speed itself is slow |
| Old text speaks after seek/stop/voice change | generation counters, cancellation, pending chunk completion, ownership | that browser media is randomly replaying |
| Highlight ahead/behind sound | word-boundary interpretation, timing map, playback clock/rate | that DOM extraction alone is wrong |
| Highlight points at wrong paragraph | text model snapshot, batch mapping, dynamic page mutation, stale injection | that audio timing itself is wrong |
| Pause/resume restarts or skips | backend-specific lifecycle semantics, buffer/currentTime state, reader cursor | that voice generation is wrong |
| Speed change breaks sync | synthesis-rate vs client playback-rate semantics, media clock mapping | that boundaries are necessarily wrong at 1x |
| Two tabs interfere | browser audio ownership, Web Speech/chrome.tts shared state | that each tab's reader state is not independent |
| Stable/dev HUD disappears or changes | shared DOM IDs/highlight names/bootstrap cleanup | that extension unloaded |
| Diagnostic launch affects user's real Edge | same-profile single-instance routing / wrong process ownership | that `msedge.exe` created an isolated browser |
| Disposable browser shows account state | account bootstrap/sync/import | that new filesystem profile is identity-isolated |
| Extension reload seems ineffective in open tab | already-injected content script/session state | that disk source did not update |

If no row matches, add the new symptom and the eventual proven cause after diagnosis.

---

## 8. Hazard: stable Edge is production

The stable browser is not a test harness.

By default, agents may inspect repository state and reason from already-collected evidence, but the real stable Edge profile, its windows, its processes, its extension lifecycle, and its account/session state are protected surfaces.

Do not automatically:

- close or restart the real Edge instance;
- reload/uninstall/reinstall the stable extension;
- navigate the real browser to diagnostic URLs;
- launch the real profile with experimental command-line flags;
- inject logging flags into the real profile;
- modify stable profile files;
- alter account, sync, sign-in, history, password, autofill, favorite, or session state.

Any operation that visibly changes the real stable browser requires explicit user approval for that exact operation.

---

## 9. Hazard: Edge windows are not independent browser instances

Multiple visible Edge windows can belong to the same profile and the same browser process tree.

On 2026-09-15 two visible windows (`Current` and `YOutube`) both belonged to the stable `Default` profile and the same root Edge process. Treating one visible window as "the browser" was incorrect.

Before any operation involving Edge process lifecycle, establish inline:

- how many visible Edge windows exist;
- which profile each belongs to;
- which root browser process owns them;
- whether another window/process would keep the browser instance alive.

This check is a safety precondition inside the real task, not a separate diagnostic project.

---

## 10. Hazard: launching the same profile is not isolation

Launching another `msedge.exe` with `--profile-directory=Default` does not guarantee a new independent browser. Edge can hand the launch request, URL, or flags to an already-running instance using that profile.

This caused a 2026-09-15 diagnostic prompt to interfere with the user's actual Edge window.

Never use the real profile as a temporary diagnostic instance. In particular, do not assume that adding logging flags to a second launch creates a clean logging browser.

---

## 11. Hazard: temporary diagnostics must include restoration before execution

Any temporary change must have its complete restoration path specified before it starts.

For example, a temporary logging run must define, in advance:

1. what process/profile is allowed to be changed;
2. how the diagnostic state is created;
3. how success/failure is captured;
4. how the diagnostic process is fully terminated;
5. how normal operation is restored;
6. how absence of residual flags/configuration is verified.

A prompt that creates temporary state without specifying and verifying teardown is incomplete and must not be executed.

---

## 12. Hazard: disposable browser state is not automatically anonymous

A new `--user-data-dir` is filesystem isolation, not necessarily identity isolation.

A disposable Edge instance may still interact with Windows/Edge account bootstrap, sign-in, sync, import, or other identity-bearing state. During the 2026-09-15 investigation, an isolated-profile experiment unexpectedly became associated with the user's account. That was outside the intended test boundary.

Any isolated-browser experiment must be explicitly accountless and must stop if authentication, sync, import, or personal account state appears. Disposable profile does not imply disposable identity.

---

## 13. Hazard: UI automation can hit the wrong Edge window

Generic keyboard/mouse automation is unsafe when multiple Edge windows exist.

Before any UI action against an isolated test browser, automation must prove the target window belongs to the intended isolated process tree, focus that exact handle, and re-check foreground ownership. If the check fails, stop. Never send generic input merely because an Edge window is visible.

A 2026-09-15 isolated test correctly stopped after detecting that focus had landed on a real Edge window. That stop behavior is mandatory.

Prefer non-UI control surfaces such as CDP when they can preserve the behavior under test.

---

## 14. Hazard: extension install context changes behavior

An extension loaded with `--load-extension` is not necessarily operationally equivalent to one manually loaded through `edge://extensions` as an unpacked extension.

During diagnosis, a disposable command-line-loaded instance preserved the stable extension ID but produced `Native Messaging request timed out: hello` rather than the real stable profile's `Access to the specified native messaging host is forbidden` error. That means install context is a meaningful variable and results cannot be generalized across those two modes without proof.

Always record:

- extension ID;
- source path;
- installation/location type;
- profile/user-data-dir;
- whether the result came from real stable, dev, or disposable browser state.

---

## 15. Hazard: extension identity is a security principal, not a cosmetic identifier

For Native Messaging, `chrome-extension://<id>/` is part of the authorization boundary.

Because unpacked extension identity can depend on the absolute load path when no fixed manifest `key` is used, stable and development may run identical source while presenting different origins to Edge and the native-host manifest.

Therefore:

- never copy an `allowed_origins` entry from one channel and assume it covers the other;
- never describe two unpacked installs as "the same extension" without naming IDs;
- never change load paths casually if Native Messaging authorization is involved;
- record extension ID as part of every browser-facing WIN-NATURAL result.

---

## 16. Hazard: Native Messaging is shared OS state

The Native Messaging host is external machine state, not repository-local state.

The host name is `com.sguzman.edge_tts.win_natural`. Edge resolves it through Windows registration to a host manifest containing `allowed_origins` and an executable path.

Stable and development currently depend on this shared host registration. That creates coupling between otherwise isolated extension channels.

The installer previously overwrote `allowed_origins`, temporarily removing the other extension's authorization. A development fix (`071328c5`, `Preserve existing Native Messaging origins`) changed the installer to preserve/merge existing origins, but the general hazard remains: a shared mutable host manifest can make one channel break the other.

The stronger isolation model is still the one already stated in `DEV_ISOLATION.md`: use a dev-specific Native Messaging registration/name and installed host path, or another design that provably prevents development operations from mutating production authorization.

---

## 17. Hazard: machine configuration can look correct while Edge still rejects it

Native Messaging authorization is a multi-party decision. Inspecting the registry and manifest is necessary but not sufficient.

During the 2026-09-15 stable investigation:

- the expected registry registration was present;
- the host manifest path was inspectable;
- the manifest contained both stable and development origins after the merge fix;
- direct x64 host probes succeeded;
- SAPI/Aria enumeration succeeded;
- the real stable profile still returned `Access to the specified native messaging host is forbidden`.

This establishes an important evidence rule: **the browser's effective authorization decision is itself a separate surface.** The exact internal cause of the remaining stable-profile discrepancy should not be promoted from hypothesis to fact without direct evidence.

Profile/history-dependent authorization state is a plausible class of cause, but until proven it must remain labeled as a hypothesis.

---

## 18. Hazard: native-host success is not browser success

A successful direct host probe establishes only part of the system.

`hello` and `voices` succeeding outside Edge prove that:

- the executable can launch;
- the protocol is alive;
- x64/SAPI enumeration works;
- Microsoft Aria can be discovered by the helper.

They do **not** prove that Edge authorizes a particular extension origin, that the background service worker can connect, or that the reader can enumerate/use the voice.

Browser-facing deployment is complete only when browser-facing evidence passes.

---

## 19. Hazard: generated audio is not audible playback

Synthesis and playback are separate systems.

A backend can successfully produce valid MP3/WAV plus correct timing metadata and still fail at the browser boundary because:

- user activation expired during asynchronous setup;
- `HTMLMediaElement.play()` was rejected;
- the media element was superseded by a newer request;
- a stale result was correctly or incorrectly discarded;
- the Web Audio context/gain path is not active as expected;
- another ownership/cancel path intervened.

This distinction mattered in the fresh development profile for Online Natural playback: asynchronous work around voice/settings/startup could outlive the initiating user gesture, exposing autoplay/user-activation behavior even though synthesis itself was healthy.

Never respond to "no sound" by immediately rewriting the synthesis layer. Determine whether bytes were generated, decoded, authorized to play, and actually reached the audible output path.

---

## 20. Hazard: async correctness expires with time

Speech generation is asynchronous. The user can seek, stop, change voice, quit, refresh text, or start a new session while older work is still in flight.

Therefore a synthesis result can be perfectly valid in isolation and **invalid for the current reader state**.

Generation/request identifiers and cancellation guards are safety mechanisms, not implementation trivia. Any change to chunking, prefetch, backend switching, pause/resume, or media construction must prove that stale completions cannot:

- start obsolete audio;
- advance the model cursor;
- overwrite the current media object;
- restore old highlight state;
- steal audio ownership from the current session.

---

## 21. Hazard: long-text performance is a scheduling problem, not a license to synthesize the document

A major successful architectural change was to bound synthesis work into batches/chunks so first playback latency does not grow with the entire remaining document.

Do not regress to "synthesize everything, then play" while trying to simplify another failure.

The scheduler must preserve all of the following simultaneously:

- bounded first-audio latency;
- ordered continuation;
- sentence/paragraph mapping;
- cancellation and seek correctness;
- backend-specific request limits;
- Native Messaging frame limits for local WAV;
- timing continuity at chunk boundaries.

Chunking solved a real problem. Treat it as a protected invariant unless the task explicitly redesigns scheduling.

---

## 22. Hazard: word timing crosses coordinate systems

Word boundaries originate in a speech system. Highlight ranges originate in a DOM/text model. Media playback advances in seconds. These are different coordinate systems.

The synchronization path can involve:

```text
speech-service/SAPI character offsets
  -> synthesized text offsets
  -> batch/chunk offsets
  -> reader model token offsets
  -> source DOM Text node offsets

speech-service/SAPI time offsets
  -> source-audio media time
  -> HTMLMediaElement.currentTime
  -> currently active token/range
```

Punctuation normalization, paragraph aggregation, chunk boundaries, seeking, dynamic DOM changes, playback-rate changes, and stale text models can all make the audio correct while highlighting is wrong.

Any timing/highlighting diagnosis must identify which mapping is incorrect rather than treating "sync" as one state variable.

---

## 23. Hazard: multiple backends share one UX but not one set of semantics

`[ONLINE]`, `[WIN-NATURAL]`, and `[WIN-LEGACY]` are presented through the same reader, but they differ in transport and lifecycle.

- `[ONLINE]`: Microsoft Edge consumer Read Aloud transport -> MP3 + word timing -> browser media playback.
- `[WIN-NATURAL]`: Native Messaging -> x64 helper -> SAPI/NaturalVoiceSAPIAdapter -> WAV + `SpeakProgress` -> browser media playback.
- `[WIN-LEGACY]`: Web Speech and/or `chrome.tts` -> browser/OS speech lifecycle and events.

A control such as pause, resume, cancel, speed, volume, or ownership can therefore require different low-level behavior while preserving the same user-facing contract.

Never assume that a fix validated on one backend automatically validates another.

---

## 24. Hazard: profile/browser evidence must not be collapsed into "the extension"

This project has several independent state layers:

- Git branch/commit;
- stable worktree;
- development worktree;
- stable extension identity;
- development extension identity;
- browser profile state;
- browser process/window state;
- extension service-worker state;
- already-injected tab/content-script state;
- extension storage/settings state;
- Native Messaging registry state;
- Native Messaging host manifest state;
- native executable state;
- adapter/SAPI state;
- voice-asset state;
- account/sync state;
- human QA state.

Agents must name which layer a fact belongs to. "WIN-NATURAL works" is invalid unless the exact layer is stated.

For example, as of this incident:

- source promotion: complete;
- direct native helper: healthy;
- machine registration as inspected on disk: contains both stable and development origins;
- real stable browser authorization: failing;
- stable Local Aria reader experience: not working.

Those facts are not contradictory because they describe different layers.

---

## 25. Hazard: repository isolation is not runtime isolation

Separate branches/worktrees are necessary but insufficient.

Stable and development can still collide through:

- shared Native Messaging registry/manifest state;
- shared adapter registration;
- shared extracted voice configuration;
- identical DOM IDs/data attributes;
- identical CSS Custom Highlight names;
- browser-global/local speech facilities;
- user/account state;
- human QA accidentally targeting the wrong profile/window.

`DEV_ISOLATION.md` defines the stronger runtime requirements. Do not claim a test is isolated merely because it ran from `edge-tts-dev`.

---

## 26. Hazard: dev success cannot be promoted to stable by analogy

A fresh development profile can be a cleaner environment than the long-lived stable profile. That makes dev extremely useful for proving that the architecture **can** work, but it does not prove that the stable profile currently possesses the same effective state.

When dev succeeds and stable fails, freeze the working dev evidence and compare surfaces systematically:

- extension ID/origin;
- install method;
- profile/user-data-dir;
- extension storage;
- service-worker lifecycle;
- injected page version;
- Native Messaging manifest/registry;
- browser-facing diagnostics;
- account/sync state;
- process topology.

Do not respond by repeatedly changing the already-working implementation until evidence shows the implementation is the differing variable.

---

## 27. Diagnostic ladder: least invasive evidence first

Use the lowest-risk action that can discriminate between hypotheses.

### Level 0 — repository/read-only evidence

- source/branch/commit inspection;
- tests/checks;
- documentation/history;
- static protocol/config inspection.

### Level 1 — external machine state, read-only

- registry values;
- manifest contents;
- executable/runtime presence;
- adapter/token enumeration;
- process listing.

### Level 2 — direct component probes outside the browser

- native `hello`;
- native `voices`;
- bounded synthesis probe;
- WAV/boundary validation.

### Level 3 — disposable dev browser/profile

- dev extension diagnostics;
- dev real playback QA;
- no stable mutation;
- explicitly accountless isolation.

### Level 4 — stable browser read-only observation

- existing diagnostics/output visible without reload/restart/mutation;
- exact profile/extension identity recorded.

### Level 5 — stable browser mutation

Examples: extension reload, profile restart, diagnostic navigation, installation change. Requires explicit user approval for the exact operation and a restoration contract when temporary.

### Level 6 — shared/system mutation

Examples: Native Messaging registration rewrite, adapter registration change, voice-package/config change. Requires explicit scope, rollback, and proof that stable can be restored.

Escalate only when the previous level cannot answer the question. Do not use a higher-risk layer merely because it is convenient.

---

## 28. Required diagnostic record

For any nontrivial WIN-NATURAL/browser-runtime investigation, record enough context that the result can be reproduced and not misapplied:

```text
Date/time:
Goal/symptom:
Repository path:
Branch + commit:
Extension ID:
Extension source path:
Install method:
Edge profile / user-data-dir:
Edge version (if relevant):
Backend under test:
Native host name/path:
Native host manifest path:
Allowed origin(s):
Helper architecture/runtime:
Adapter/token state:
Voice asset/config state:
Network state (if relevant):
Observed error/result:
Layer proven healthy:
Layer still unproven:
Temporary mutations made:
Restoration verified:
Human QA result:
```

The point is provenance, not paperwork. Without this context, a result from dev can be accidentally treated as evidence about stable or a direct helper probe can be accidentally treated as browser authorization proof.

---

## 29. 2026-09-15 coordination failure

The coordinating assistant failed the user in several specific ways:

1. It did not consistently treat the stable Edge reader as production infrastructure even though the repository already documented that requirement.
2. It failed to check the multi-window/process topology before proposing browser lifecycle operations.
3. It proposed launching the real `Default` profile for temporary logging, which allowed Edge's single-instance behavior to interfere with the user's actual browser window.
4. It initially proposed a temporary logging operation without a sufficiently explicit teardown/restoration contract.
5. It responded to uncertainty by creating repeated preparatory/forensic turns, slowing progress without proportionate new evidence.
6. It broadened diagnostic authority after earlier mistakes instead of reducing the amount of live state it was allowed to touch.
7. It treated a disposable `--user-data-dir` as adequate isolation without also protecting account/sign-in/sync identity.
8. It changed terminology and dropped established project-state conventions during a high-risk debugging sequence, increasing cognitive load while the user was already tracking multiple projects.
9. It repeatedly inferred likely causes too early and then required the user to absorb the cost when those hypotheses failed. In particular, profile/history-dependent authorization remains a hypothesis unless directly proven.
10. It violated the spirit of `DEV_ISOLATION.md`, whose existing text already warned that the stable reader must remain available and that the single shared Native Messaging host was insufficient for safe dual-channel operation.

These were coordination failures, not unavoidable properties of Edge or Native Messaging. Future agents should not normalize them as "debugging is messy."

---

## 30. Mandatory operating rules

For every future Edge TTS task:

1. **Protect stable by default.** Real stable Edge/profile/account/process state is read-only unless the user explicitly approves a specific mutation.
2. **Keep project state explicit.** State whether the task is stable, development, machine registration, browser profile, native helper, adapter/SAPI, voice assets, playback, synchronization, or human QA.
3. **Name the principal.** For Native Messaging/browser work, record the exact extension ID and profile. "The extension" is not specific enough.
4. **No silent scope expansion.** If the next step requires touching a new live surface, stop and ask before crossing that boundary.
5. **One discriminating action per live test.** Do not turn the user's environment into an exploratory test bench.
6. **Safety checks belong inside the action.** Do not waste separate turns inventorying facts that can be checked as preconditions.
7. **Temporary state requires verified teardown.** Restoration is part of the task, not an optional follow-up.
8. **No generic UI automation against Edge.** Prove process/window ownership first or use a safer control surface.
9. **Do not equate repository success with deployment success.** Tests/commits/native probes cannot substitute for browser verification.
10. **Do not equate generated audio with audible playback.** Prove media authorization/output separately.
11. **Do not equate dev success with stable success.** Transfer only claims whose surfaces are actually shared and proven equivalent.
12. **Preserve proven layers.** If synthesis/chunking/timing is already proven, do not rewrite it merely because a downstream integration layer fails.
13. **Keep hypotheses labeled.** Opaque Edge/profile behavior invites storytelling; distinguish observation, inference, and proven cause.
14. **Do not make the user a command/push monkey.** Repository implementation/housekeeping should be handled by the engineering agents/tools; human actions should be tiny and genuinely discriminating.
15. **Stop when evidence is insufficient.** Do not compensate for uncertainty by taking more power over the live environment.
16. **Update this document after novel failures.** If the system surprises us once, convert the surprise into an explicit hazard or evidence rule.

---

## 31. Required reading

Before any task that touches Edge processes, profiles, Native Messaging, Windows Natural voices, account state, or stable deployment, read this document together with:

- `docs/DEV_ISOLATION.md`
- `docs/STABILITY.md`
- `docs/WIN_NATURAL.md`
- `docs/ARCHITECTURE.md`
- `docs/DIRECT_AUDIO.md` when Online/direct media playback or shared media-clock behavior is involved

The purpose is not ceremony. The purpose is to ensure that a feature request cannot again be mistaken for a repository-local change when its real execution path crosses browser, OS, Microsoft speech, native-process, media, and human-QA boundaries.
