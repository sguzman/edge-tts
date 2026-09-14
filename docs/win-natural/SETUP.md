# Windows Natural setup

This document describes the verified setup path for making a compatible Microsoft Narrator Natural voice visible to the `edge-tts` development extension through a persistent x64 Native Messaging helper.

It deliberately separates **machine prerequisites**, **adapter discovery**, **native-host registration**, and **browser verification**. Do not collapse these into one giant installer until each layer is understood and independently testable.

## 1. Preconditions

Use an x64 Windows machine. The verified path uses:

- Microsoft Edge;
- .NET Windows Desktop runtime compatible with the helper target framework;
- x64 `NaturalVoiceSAPIAdapter` v0.2.4;
- a compatible extracted Narrator Natural voice package;
- this repository checked out on the development integration branch;
- an unpacked Edge extension loaded from the development worktree;
- a second Edge profile for development testing so the stable reader remains untouched.

The current Microsoft Store Natural voice packages are not assumed to be directly consumable by the adapter. The verified Aria proof used an older compatible Aria v2 package generation. Do not replace, uninstall, or downgrade the current Store package merely to satisfy this project.

## 2. Keep the stable reader isolated

The load-bearing reader should be loaded from the stable worktree. Development should occur in a separate worktree, for example:

```powershell
C:\Users\<user>\Documents\GitHub\edge-tts
C:\Users\<user>\Documents\GitHub\edge-tts-dev
```

The development Edge profile should load only the development worktree. Native-host authorization must use that development extension's actual unpacked extension ID.

## 3. Install/register the x64 adapter

Install only the x64 `NaturalVoiceSAPIAdapter` registration using the adapter's documented registration method. The verified setup intentionally did not depend on an x86 registration.

After registration, verify that the x64 COM registration points at the expected `NaturalVoiceSAPIAdapter.dll` and that the file exists.

The helper diagnostics can report the registered adapter paths in both 64-bit and 32-bit registry views.

## 4. Prepare a compatible extracted Narrator voice

The verified local Natural voice was:

```text
name: Microsoft Aria
language: en-US
```

The package is external to this repository. Keep it in a dedicated extracted directory. Do not commit Microsoft voice package contents.

The proof-of-concept originally configured the adapter with:

```text
HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator
```

including a `NarratorVoicePath` pointing at the extracted package and testing-oriented values such as:

```text
NoNarratorVoices = 0
NoEdgeVoices     = 1
NoAzureVoices    = 1
```

That configuration works in ordinary directly launched processes, but Edge Native Messaging was observed to lose visibility of this per-user adapter key even under the same user SID. For that reason, **the browser integration must not rely exclusively on this registry path**.

## 5. Create the registry-independent NarratorVoices junction

The reliable browser-visible solution uses the adapter's default filesystem discovery location:

```text
<adapter-x64-directory>\NarratorVoices
```

Create a directory junction from that default location to the already-working extracted Aria directory.

Generic form:

```powershell
New-Item -ItemType Junction `
  -Path '<adapter-x64-directory>\NarratorVoices' `
  -Target '<compatible-extracted-aria-directory>'
```

Verified-machine shape:

```text
adapter-v0.2.4\x64\NarratorVoices
    -> aria-v2
```

This does not copy or move the voice package.

Rollback is simply:

```powershell
Remove-Item -LiteralPath '<adapter-x64-directory>\NarratorVoices'
```

Before creating the junction, verify that the target `NarratorVoices` path does not already contain unrelated user data.

## 6. Build the x64 Native Messaging helper

From the development repository root:

```powershell
dotnet publish .\native\win-natural\WinNaturalHost.csproj `
  -c Release `
  -r win-x64 `
  --self-contained false
```

The published helper should be x64. The helper uses Native Messaging framing on stdin/stdout and, at Gate 1, supports protocol handshake and voice enumeration only.

Do not write diagnostic or log text to stdout outside Native Messaging frames. stdout is protocol data.

## 7. Register the Edge Native Messaging host

Find the development extension ID:

1. open `edge://extensions` in the development Edge profile;
2. enable Developer mode;
3. locate the unpacked `Edge Natural TTS` card;
4. copy the displayed extension ID.

Then run:

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\native\win-natural\install-native-host.ps1 `
  -ExtensionId '<development-extension-id>'
```

The install script writes a per-user Native Messaging registration under:

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural
```

and writes the Native Messaging manifest under the user's local app-data tree.

The manifest's `allowed_origins` entry must exactly match:

```text
chrome-extension://<development-extension-id>/
```

Do not authorize the stable extension accidentally merely because it is another unpacked copy of the same source.

## 8. Reload Edge extension state

After changing the helper binary, native-host manifest, extension manifest, or junction:

1. reload the development extension in `edge://extensions`;
2. if process state may be stale, fully restart Edge;
3. reopen the extension service-worker DevTools;
4. run the direct transport diagnostic.

At Gate 1 the direct service-worker diagnostic is:

```javascript
globalThis.EdgeTtsNativeMessaging
  .createTransport()
  .diagnostics()
  .then(console.log)
  .catch(console.error)
```

Do not call `chrome.runtime.sendMessage({ type: "EDGE_TTS_NATIVE_DIAGNOSTICS" })` from the service worker unless a receiver is explicitly installed. Gate 1 intentionally removed the second runtime message listener because it interfered with existing reader behavior.

## 9. Expected success result

A successful Gate 1 diagnostic should contain:

```text
connected: true
handshake.protocol: 1
handshake.architecture: x64
voices:
  - id: Local-NarratorVoices
    name: Microsoft Aria
    lang: en-US
ariaFound: true
```

The literal token ID is **not canonical**. Earlier proof-of-concept discovery produced `Local-aria-v2`; filesystem-default discovery produced `Local-NarratorVoices`. Preserve the real returned token ID and treat the logical match as:

```text
id begins with Local-
name == Microsoft Aria
lang == en-US
```

## 10. Verify existing reader behavior

Before advancing beyond Gate 1, manually verify that Native Messaging integration has not regressed the existing backends:

```text
Online Natural first playback: PASS
Online Natural playback after pause/stop: PASS
Windows Legacy playback: PASS
Stop: PASS
Quit: PASS
```

Windows Natural playback itself is not a Gate 1 requirement. Enumeration comes first.

## 11. What is intentionally not required

The final Gate 1 setup does **not** require:

- replacing the Store Aria package;
- enabling an Edge enterprise policy for direct native-host launch;
- adding a second global `chrome.runtime.onMessage` listener for diagnostics;
- exposing Aria in the normal voice picker;
- routing normal reader speech through the helper;
- committing Microsoft voice package files;
- modifying the stable worktree.

## 12. Full rollback

To remove only project-owned integration state:

1. remove the Edge Native Messaging registration with the repository's uninstall script;
2. remove the `NarratorVoices` junction;
3. unload the development extension or switch branches/worktrees as desired.

Adapter registration and extracted Microsoft package state are external prerequisites and should be rolled back only with their own explicit procedures. Do not make the repository uninstall script responsible for deleting unrelated system-level or third-party installation state.
