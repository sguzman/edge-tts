# Stable Voice Preferences — Isolated Browser QA

Date: 2026-09-20

## Candidate

- Maintenance branch: `maintenance/stable-voice-preferences`
- Stable base: `792fa64553546844c6ce109bf9243b848910e20b`
- Candidate: `326b1fe0211c847bf321e44ad2e25e0ed5c2cc0f`
- Edge: `153.0.4234.48`
- Extension loading: command-line `--disable-extensions-except` and `--load-extension` from the maintenance worktree; Native Messaging was out of scope.

## Isolation result

Isolation **FAILED before QA**. The disposable Edge profile displayed Edge
sync/account UI stating that an account was signed in on the device and that
browsing data was being synchronized. This violated the requirement for a
disposable unauthenticated, non-sync profile.

- Disposable profile: `C:\Users\guzma\AppData\Local\Temp\edge-voice-preferences-qa-20260920-064906-927`
- Disposable root process: `40588`
- The isolated Edge process tree was closed after the failure.
- The disposable profile was intentionally retained for forensic inspection.

No browser QA was performed after the failed isolation check.

## QA cases

| Case | Result | Notes |
|---|---|---|
| A. Initial default | NOT TESTED | Isolation failed first. |
| B. Default startup voice UI | NOT TESTED | Isolation failed first. |
| C. Cross-session persistence | NOT TESTED | Isolation failed first. |
| D. Static order | NOT TESTED | Isolation failed first. |
| E. All voices catalog | NOT TESTED | Isolation failed first. |
| F. Deterministic fallback | NOT TESTED | Isolation failed first. |

## Automated verification

The candidate's repository verification before this QA run was:

- `npm test`: 154 passed, 0 failed
- `npm run check`: passed
- `git diff --check`: passed

## Protected surfaces

The real stable Edge environment, real Default profile, stable branch,
registry, Native Messaging registration, native host, account state, and
Local Aria/WIN-NATURAL integration were not touched.

This candidate is **not QA-qualified** because the required isolated browser
environment was not established.

## Attempt 2 — Windows Sandbox availability check

Date: 2026-09-20

The required Windows Sandbox QA run was not performed because Sandbox was not
available/usable in this session. Read-only checks found:

- OS: Windows 11 Pro, build 26200.
- `wsb.exe`: not available on `PATH`.
- `%WINDIR%\System32\WindowsSandbox.exe`: not present.
- The servicing store contains `Containers-DisposableClientVM` packages, but
  querying the authoritative optional-feature state with
  `Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM`
  requires elevation and was unavailable in this session.
- No optional feature, Hyper-V setting, registry value, user, browser profile,
  or other host state was changed.

Because a usable Windows Sandbox could not be established, the objective's
required A–F browser cases remain untested. No host Edge fallback was used.

| Case | Result | Notes |
|---|---|---|
| A. Initial default | NOT TESTED | Windows Sandbox unavailable/usable state not established. |
| B. Default startup voice UI | NOT TESTED | Windows Sandbox unavailable/usable state not established. |
| C. Cross-session persistence | NOT TESTED | Windows Sandbox unavailable/usable state not established. |
| D. Static order | NOT TESTED | Windows Sandbox unavailable/usable state not established. |
| E. All voices catalog | NOT TESTED | Windows Sandbox unavailable/usable state not established. |
| F. Deterministic fallback | NOT TESTED | Windows Sandbox unavailable/usable state not established. |

The prior host-profile isolation failure remains preserved above. The real host
Edge environment, Default profile, stable branch, registry, policies, and
Native Messaging registration were not touched.
