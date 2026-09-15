# Live operational hazards

`edge-tts` is not just a repository. It is a load-bearing reading system attached to a live Edge installation, browser profiles, extension identities, Windows processes, Native Messaging registration, account state, and a user-visible stable runtime.

Any agent working on this project must treat those live surfaces as production infrastructure.

This document exists because that boundary was violated during the 2026-09-15 WIN-NATURAL rollout/diagnosis. The coordinating assistant repeatedly treated live browser state as ordinary debugging substrate, disrupted progress, and created avoidable risk around the user's working reader. Future agents must understand both the technical hazards and the coordination failures that exposed them.

## Current protected state

- The normal Edge `Default` profile is the user's load-bearing reading environment.
- The stable unpacked extension ID is `gfeeggciegdnlpdmebfjmahboogkilhi` and its source path is `C:\Users\guzma\Documents\GitHub\edge-tts`.
- The development extension ID is `gajodjkpikfgfbcobncfacbjeaekgefb` and its source path is `C:\Users\guzma\Documents\GitHub\edge-tts-dev`.
- Windows Legacy and Online Natural are working reader backends and must not be disturbed while diagnosing WIN-NATURAL.
- Gate 5 source promotion reached stable commit `792fa64553546844c6ce109bf9243b848910e20b`.
- Stable WIN-NATURAL deployment is **not complete**. On the real stable profile, the diagnostics page still reports `Access to the specified native messaging host is forbidden`, and Local Aria is not available to the reader.
- Direct native-host probes do work: `hello` reports protocol 1/x64 and `voices` returns `Local-aria-v2 / Microsoft Aria / en-US`. That proves host/SAPI health, not browser authorization.

Do not call WIN-NATURAL stable until the stable diagnostics page itself connects and enumerates Microsoft Aria and the stable reader can actually use it.

## Hazard 1: stable Edge is production

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

## Hazard 2: Edge windows are not independent browser instances

Multiple visible Edge windows can belong to the same profile and the same browser process tree.

On 2026-09-15 two visible windows (`Current` and `YOutube`) both belonged to the stable `Default` profile and the same root Edge process. Treating one visible window as "the browser" was incorrect.

Before any operation involving Edge process lifecycle, establish inline:

- how many visible Edge windows exist;
- which profile each belongs to;
- which root browser process owns them;
- whether another window/process would keep the browser instance alive.

This check is a safety precondition inside the real task, not a separate diagnostic project.

## Hazard 3: launching the same profile is not isolation

Launching another `msedge.exe` with `--profile-directory=Default` does not guarantee a new independent browser. Edge can hand the launch request, URL, or flags to an already-running instance using that profile.

This caused a 2026-09-15 diagnostic prompt to interfere with the user's actual Edge window.

Never use the real profile as a temporary diagnostic instance. In particular, do not assume that adding logging flags to a second launch creates a clean logging browser.

## Hazard 4: temporary diagnostics must include restoration before execution

Any temporary change must have its complete restoration path specified before it starts.

For example, a temporary logging run must define, in advance:

1. what process/profile is allowed to be changed;
2. how the diagnostic state is created;
3. how success/failure is captured;
4. how the diagnostic process is fully terminated;
5. how normal operation is restored;
6. how absence of residual flags/configuration is verified.

A prompt that creates temporary state without specifying and verifying teardown is incomplete and must not be executed.

## Hazard 5: disposable browser state is not automatically anonymous

A new `--user-data-dir` is filesystem isolation, not necessarily identity isolation.

A disposable Edge instance may still interact with Windows/Edge account bootstrap, sign-in, sync, import, or other identity-bearing state. During the 2026-09-15 investigation, an isolated-profile experiment unexpectedly became associated with the user's account. That was outside the intended test boundary.

Any isolated-browser experiment must be explicitly accountless and must stop if authentication, sync, import, or personal account state appears. Disposable profile does not imply disposable identity.

## Hazard 6: UI automation can hit the wrong Edge window

Generic keyboard/mouse automation is unsafe when multiple Edge windows exist.

Before any UI action against an isolated test browser, automation must prove the target window belongs to the intended isolated process tree, focus that exact handle, and re-check foreground ownership. If the check fails, stop. Never send generic input merely because an Edge window is visible.

A 2026-09-15 isolated test correctly stopped after detecting that focus had landed on a real Edge window. That stop behavior is mandatory.

Prefer non-UI control surfaces such as CDP when they can preserve the behavior under test.

## Hazard 7: extension install context changes behavior

An extension loaded with `--load-extension` is not necessarily operationally equivalent to one manually loaded through `edge://extensions` as an unpacked extension.

During diagnosis, a disposable command-line-loaded instance preserved the stable extension ID but produced `Native Messaging request timed out: hello` rather than the real stable profile's `Access to the specified native messaging host is forbidden` error. That means install context is a meaningful variable and results cannot be generalized across those two modes without proof.

Always record:

- extension ID;
- source path;
- installation/location type;
- profile/user-data-dir;
- whether the result came from real stable, dev, or disposable browser state.

## Hazard 8: Native Messaging is shared OS state

The Native Messaging host is external machine state, not repository-local state.

The host name is `com.sguzman.edge_tts.win_natural`. Edge resolves it through Windows registration to a host manifest containing `allowed_origins` and an executable path.

Stable and development currently depend on this shared host registration. That creates coupling between otherwise isolated extension channels.

The installer previously overwrote `allowed_origins`, temporarily removing the other extension's authorization. A development fix (`071328c5`, `Preserve existing Native Messaging origins`) changed the installer to preserve/merge existing origins, but the general hazard remains: a shared mutable host manifest can make one channel break the other.

The stronger isolation model is still the one already stated in `DEV_ISOLATION.md`: use a dev-specific Native Messaging registration/name and installed host path, or another design that provably prevents development operations from mutating production authorization.

## Hazard 9: native-host success is not browser success

A successful direct host probe establishes only part of the system.

`hello` and `voices` succeeding outside Edge prove that:

- the executable can launch;
- the protocol is alive;
- x64/SAPI enumeration works;
- Microsoft Aria can be discovered by the helper.

They do **not** prove that Edge authorizes a particular extension origin, that the background service worker can connect, or that the reader can enumerate/use the voice.

Browser-facing deployment is complete only when browser-facing evidence passes.

## Hazard 10: profile/browser evidence must not be collapsed into "the extension"

This project has several independent state layers:

- Git branch/commit;
- stable worktree;
- development worktree;
- stable extension identity;
- development extension identity;
- browser profile state;
- browser process/window state;
- Native Messaging registry state;
- Native Messaging host manifest state;
- native executable state;
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

## 2026-09-15 coordination failure

The coordinating assistant failed the user in several specific ways:

1. It did not consistently treat the stable Edge reader as production infrastructure even though the repository already documented that requirement.
2. It failed to check the multi-window/process topology before proposing browser lifecycle operations.
3. It proposed launching the real `Default` profile for temporary logging, which allowed Edge's single-instance behavior to interfere with the user's actual browser window.
4. It initially proposed a temporary logging operation without a sufficiently explicit teardown/restoration contract.
5. It responded to uncertainty by creating repeated preparatory/forensic turns, slowing progress without proportionate new evidence.
6. It broadened diagnostic authority after earlier mistakes instead of reducing the amount of live state it was allowed to touch.
7. It treated a disposable `--user-data-dir` as adequate isolation without also protecting account/sign-in/sync identity.
8. It changed terminology and dropped established project-state conventions during a high-risk debugging sequence, increasing cognitive load while the user was already tracking multiple projects.
9. It repeatedly inferred likely causes too early (for example, stale browser authorization) and then required the user to absorb the cost when those hypotheses failed.
10. It violated the spirit of `DEV_ISOLATION.md`, whose existing text already warned that the stable reader must remain available and that the single shared Native Messaging host was insufficient for safe dual-channel operation.

These were coordination failures, not unavoidable properties of Edge or Native Messaging. Future agents should not normalize them as "debugging is messy."

## Mandatory operating rules

For every future Edge TTS task:

1. **Protect stable by default.** Real stable Edge/profile/account/process state is read-only unless the user explicitly approves a specific mutation.
2. **Keep project state explicit.** State whether the task is stable, development, machine registration, browser profile, native helper, or human QA.
3. **No silent scope expansion.** If the next step requires touching a new live surface, stop and ask before crossing that boundary.
4. **One discriminating action per live test.** Do not turn the user's environment into an exploratory test bench.
5. **Safety checks belong inside the action.** Do not waste separate turns inventorying facts that can be checked as preconditions.
6. **Temporary state requires verified teardown.** Restoration is part of the task, not an optional follow-up.
7. **No generic UI automation against Edge.** Prove process/window ownership first or use a safer control surface.
8. **Do not equate repository success with deployment success.** Tests/commits/native probes cannot substitute for browser verification.
9. **Do not make the user a command/push monkey.** Repository implementation/housekeeping should be handled by the engineering agents/tools; human actions should be tiny and genuinely discriminating.
10. **Stop when evidence is insufficient.** Do not compensate for uncertainty by taking more power over the live environment.

## Required reading

Before any task that touches Edge processes, profiles, Native Messaging, or stable deployment, read this document together with:

- `docs/DEV_ISOLATION.md`
- `docs/STABILITY.md`
- `docs/WIN_NATURAL.md`

The purpose is not ceremony. The purpose is to ensure that a development task cannot again turn the user's working reader into collateral damage.
