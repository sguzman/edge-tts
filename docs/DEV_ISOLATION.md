# Development/runtime isolation

`edge-tts` is a load-bearing reading tool. Experimental development must never be able to take the verified reader away from the user.

## Runtime layout

- `stable` branch: verified runtime only. The normal Edge profile loads the unpacked extension from `C:\Users\guzma\Documents\GitHub\edge-tts`.
- `main` branch: development/integration. A separate worktree lives at `C:\Users\guzma\Documents\GitHub\edge-tts-dev`.
- Development QA should use a dedicated Edge profile containing only the dev unpacked extension. The stable profile should contain only the stable unpacked extension.

The two unpacked extensions must be loaded from their distinct absolute paths. Neither manifest currently carries a fixed `key`, so the distinct paths produce distinct extension identities. Storage, service workers, permissions, and extension lifecycle are therefore isolated by extension identity.

## Current collision audit

The present development code is **not approved for simultaneous activation on the same document**. Stable and dev currently share DOM/CSS identifiers such as `#edge-tts-toolbar`, `data-edge-tts-ui`, and the `edge-tts-current-*` Custom Highlight names. Development bootstrap cleanup can also match production UI. Until these identifiers are channel-namespaced, activating dev on a document already running stable can damage that page's stable HUD/session.

The extensions also do not share an audio-ownership lease. Both can independently believe they own speech/audio. Concurrent playback may overlap or one speech backend may cancel another, especially for browser-global speech APIs. Manual QA must not run stable and dev speech concurrently.

## Native Messaging

Windows Natural TTS is development-only until promoted. Native Messaging is external OS state and must not become a shared mutable production dependency by accident.

Before Windows Natural QA is considered isolated, development must use a dev-specific Native Messaging host registration/name and dev-specific installed host path, or another scheme that provably cannot overwrite the production host manifest/allowed origins. The current single-host installer is not sufficient for dual-channel operation because one installation can replace the host manifest and its allowed origin.

The x64 NaturalVoiceSAPIAdapter registration is system-wide shared state. Stable has already been verified working while it is registered. Development install/uninstall scripts must not automatically unregister or replace that shared adapter as part of ordinary dev-extension lifecycle.

## Promotion rule

A development commit may advance `stable` only after:

1. automated tests/checks pass;
2. the exact candidate is manually exercised in real Edge;
3. startup, play, stop, quit, highlighting, voice selection, and the relevant backend are verified;
4. the user explicitly accepts that exact candidate as the next stable runtime.

Unit tests, native-helper tests, or an implementation agent reporting "goal achieved" are never sufficient by themselves.

## Operational rule

If dev fails, the recovery action is to close/leave the dev Edge profile and return to the normal stable profile. No branch switch, reset, uninstall, or repair of the stable runtime should be required.