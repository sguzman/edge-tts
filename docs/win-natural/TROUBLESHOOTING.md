# Windows Natural troubleshooting

This guide is symptom-driven. Start from the observed failure and test only the layer necessary to discriminate it.

Do not begin by reinstalling everything. Most failures in this stack are boundary failures between otherwise-working components.

## Quick diagnostic command

In the development extension's service-worker DevTools console:

```javascript
globalThis.EdgeTtsNativeMessaging
  .createTransport()
  .diagnostics()
  .then(console.log)
  .catch(console.error)
```

A healthy Gate 1 result should contain:

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

Save/copy the returned object as JSON when investigating complex failures. This is preferable to screenshots of nested DevTools objects.

## Symptom: `Could not establish connection. Receiving end does not exist.`

If you run:

```javascript
chrome.runtime.sendMessage({ type: "EDGE_TTS_NATIVE_DIAGNOSTICS" })
```

from the service-worker console and receive this error, it does not prove Native Messaging is broken.

Gate 1 intentionally removed the separate runtime-message diagnostics listener because it regressed existing reader behavior.

Use the direct service-worker transport command shown above instead.

## Symptom: `connected: false` or Native Messaging connection error

Check in this order:

1. extension manifest contains `nativeMessaging` permission;
2. helper was published successfully;
3. Native Messaging manifest exists;
4. Edge Native Messaging registry key points at that manifest;
5. manifest `path` points at the real `WinNaturalHost.exe`;
6. manifest `allowed_origins` exactly contains the development extension origin;
7. extension ID matches the unpacked development extension currently loaded.

Expected per-user registration:

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural
```

Reinstall registration with:

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\native\win-natural\install-native-host.ps1 `
  -ExtensionId '<development-extension-id>'
```

Do not assume the stable and development unpacked extensions share an ID.

## Symptom: handshake works, `voices: []`

This was the major Gate 1 failure.

First distinguish transport from adapter discovery:

```text
connected: true
protocol: 1
architecture: x64
voices: []
```

means Native Messaging itself is working.

Check helper diagnostics:

```text
installedVoiceCount
installedVoices
registry.currentUser
registry.hkeyUsersCurrentSid
registry.summary
```

On the verified failure, Edge saw many legacy/online voices but no `Local-*` voice.

### If direct helper sees Aria but Edge helper does not

Do not immediately reinstall the adapter.

The verified solution was to make adapter discovery registry-independent:

```powershell
New-Item -ItemType Junction `
  -Path '<adapter-x64-directory>\NarratorVoices' `
  -Target '<compatible-extracted-aria-directory>'
```

Then fully restart Edge and rerun diagnostics.

Expected voice:

```text
Local-NarratorVoices / Microsoft Aria / en-US
```

Rollback:

```powershell
Remove-Item -LiteralPath '<adapter-x64-directory>\NarratorVoices'
```

## Symptom: voice appears but `ariaFound: false`

Inspect the actual token ID.

Do **not** require:

```text
Local-aria-v2
```

The token ID depends on how the adapter discovered the package.

Verified filesystem-default token:

```text
Local-NarratorVoices
```

Logical Aria matching should use:

```text
id starts with Local-
name == Microsoft Aria
lang == en-US
```

while preserving the actual token ID unchanged for future synthesis.

## Symptom: helper enumerates 22 voices and no local Aria

The observed Edge-launched failure had roughly:

```text
installedVoiceCount: 22
```

and included many `Edge-*` online voices plus Windows legacy voices.

After the `NarratorVoices` junction worked, the count increased to 23 and the additional voice was:

```text
Local-NarratorVoices / Microsoft Aria
```

The exact count is machine-dependent, but on the verified machine that delta was strong evidence that filesystem discovery succeeded.

## Symptom: adapter registry key exists in PowerShell but not in Edge helper

This is a known observed condition.

The Edge helper may report:

```text
HKCU exact adapter key: ERROR_FILE_NOT_FOUND
HKEY_USERS\<same SID> exact adapter key: ERROR_FILE_NOT_FOUND
RegOpenCurrentUser: ERROR_SUCCESS
```

while the same exact physical key exists and is readable from PowerShell.

The investigation ruled out:

- different Windows user;
- different SID;
- x86/x64 mismatch;
- AppContainer;
- restricted token;
- simple elevation mismatch;
- enabled registry virtualization;
- `cmd.exe` intermediary as the cause.

Do not block on explaining this OS behavior. Use the registry-independent `NarratorVoices` default path.

## Symptom: parent process is `cmd.exe`

This is normal Edge behavior on some configurations.

A temporary experiment used Edge's `NativeHostsExecutablesLaunchDirectly` policy to change the topology to direct `msedge.exe -> WinNaturalHost.exe` launch.

That did **not** fix adapter registry visibility.

The working junction solution continued to work after the policy was removed.

Therefore no direct-launch policy is required for normal operation.

If `edge://policy` still shows `NativeHostsExecutablesLaunchDirectly` from debugging, remove it from an elevated PowerShell and fully restart Edge:

```powershell
Remove-ItemProperty `
  -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' `
  -Name 'NativeHostsExecutablesLaunchDirectly' `
  -ErrorAction SilentlyContinue
```

## Symptom: Online Natural gets stuck at `Starting speech…`

Do not assume this is caused by Windows Natural synthesis. Gate 0 established a separate browser user-activation issue in the direct Online Natural backend.

Check whether:

- Windows Legacy still plays;
- Online Natural is selected explicitly;
- the fresh profile has been given a user-gesture playback unlock;
- direct-audio diagnostics show WebSocket/audio frames/Blob creation/`audio.play()` result.

The verified Gate 0 fix prepares direct audio synchronously from the Play/Resume user gesture before asynchronous synthesis.

### If this regresses after Native Messaging changes

Compare against the Gate 0 checkpoint before touching the direct-audio engine.

One Gate 1 regression was caused by adding a second global `chrome.runtime.onMessage` listener for diagnostics. Removing that listener restored the original dispatcher behavior.

Treat extension-global lifecycle and messaging changes as suspect even when the direct-audio source itself is unchanged.

## Symptom: duplicate HUDs after extension reload

This occurred during the first failed integration line.

Stale DOM/session cleanup can be a real issue during unpacked extension reloads, but do not assume it explains playback failures once duplicate UI is gone.

For ordinary development testing:

- reload the extension;
- refresh/open a fresh webpage if needed;
- distinguish stale page-injected state from current source behavior.

Do not change stable merely to diagnose dev-profile reload state.

## Symptom: helper binary cannot be rebuilt because it is locked

A stale native-host process may still hold the published executable.

Try:

```powershell
taskkill /IM WinNaturalHost.exe /F
```

`process not found` is harmless.

Then republish:

```powershell
dotnet publish .\native\win-natural\WinNaturalHost.csproj `
  -c Release `
  -r win-x64 `
  --self-contained false
```

After rebuilding, reload or fully restart Edge so the next Native Messaging connection uses the new executable.

## Symptom: direct helper works but browser still shows stale behavior

Potential stale layers include:

```text
old service worker
old Native Messaging helper process
old unpacked extension files not reloaded
old page-injected content scripts
```

Use the minimum reset needed:

1. reload development extension;
2. reopen service-worker DevTools;
3. kill stale helper if necessary;
4. fully restart Edge only when process-level state or policy changed.

Do not wipe branches/worktrees as a first-line debugging strategy.

## Symptom: Windows Natural voice is visible in diagnostics but not in the normal picker

At Gate 1, this is expected.

Gate 1 proves transport/enumeration only.

Catalog visibility belongs to Gate 2. Do not "fix" Gate 1 by splicing native discovery into reader startup or voice selection prematurely.

## Symptom: Online Natural startup latency is large after pause/stop

This is a known performance concern, not currently a correctness failure.

The direct Online Natural backend performs network synthesis before playback. Network quality and full-batch accumulation can both contribute to latency.

Do not destabilize the verified playback path during Windows Natural integration merely to optimize this unrelated performance issue.

## Minimal health checklist

When unsure whether the environment is fundamentally healthy, verify:

```text
Development extension loads
Windows Legacy plays
Online Natural plays
Stop works
Quit works
Native diagnostic connects
Protocol == 1
Architecture == x64
Microsoft Aria appears as Local-* adapter voice
ariaFound == true
```

Only after this baseline is green should later Windows Natural playback work be debugged.
