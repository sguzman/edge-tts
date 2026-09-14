# Windows Natural native helper

This directory contains the x64 Native Messaging helper used by the optional Windows Natural backend.

For the complete setup, architecture, investigation history, troubleshooting, and verification record, start with:

- [`../../docs/win-natural/README.md`](../../docs/win-natural/README.md)
- [`../../docs/win-natural/SETUP.md`](../../docs/win-natural/SETUP.md)
- [`../../docs/win-natural/FORENSICS.md`](../../docs/win-natural/FORENSICS.md)
- [`../../docs/win-natural/TROUBLESHOOTING.md`](../../docs/win-natural/TROUBLESHOOTING.md)

This README stays intentionally implementation-focused.

## Current helper behavior

The helper is a persistent x64 Native Messaging process. The transport exposes:

```text
hello
voices
synthesize
```

`synthesize` requires an exact enabled `Local-*` token and returns an in-memory
WAV as correlated multipart frames:

```text
synth-start -> synth-chunk (48 KiB binary chunks) -> synth-end
```

The helper never writes audio files or plays through a native audio device.
The extension reassembles and owns browser playback. Each base64 chunk remains
well below Edge's 1 MB Native Messaging response limit.

Enumeration is filtered to SAPI voice IDs beginning with `Local-`, so ordinary Windows legacy voices are not advertised as Windows Natural voices.

The adapter token ID is discovery-path dependent. The original proof of concept exposed `Local-aria-v2`, while the registry-independent default `NarratorVoices` directory exposes `Local-NarratorVoices` on the verified machine. Treat the `Local-` prefix plus voice identity (`Microsoft Aria`, `en-US`) as the logical match and preserve the actual SAPI token ID unchanged for later native requests.

## Build

```powershell
dotnet publish .\native\win-natural\WinNaturalHost.csproj `
  -c Release `
  -r win-x64 `
  --self-contained false
```

## Register for an unpacked development extension

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\native\win-natural\install-native-host.ps1 `
  -ExtensionId '<development-extension-id>'
```

The script registers only the Edge Native Messaging host under the current user's registry hive and does not install, remove, replace, or downgrade any Microsoft voice package.

## Registry-independent Narrator discovery

On the verified machine, Edge Native Messaging could not see the adapter's per-user `NarratorVoicePath` configuration even though direct helper/PowerShell processes could.

The working browser integration therefore uses the adapter's default filesystem discovery directory:

```text
<adapter-x64-directory>\NarratorVoices
```

pointing to the already-working extracted compatible Narrator package with a reversible junction:

```powershell
New-Item -ItemType Junction `
  -Path '<adapter-x64-directory>\NarratorVoices' `
  -Target '<compatible-extracted-aria-directory>'
```

Rollback:

```powershell
Remove-Item -LiteralPath '<adapter-x64-directory>\NarratorVoices'
```

Do not copy Microsoft package contents into this repository.

## Diagnostic entry point

From the development extension service-worker DevTools console:

```javascript
globalThis.EdgeTtsNativeMessaging
  .createTransport()
  .diagnostics()
  .then(console.log)
  .catch(console.error)
```

A Gate 1 pass includes:

```text
connected: true
protocol: 1
architecture: x64
Microsoft Aria present as Local-*
ariaFound: true
```

The full manual acceptance matrix lives in [`../../docs/win-natural/VERIFICATION.md`](../../docs/win-natural/VERIFICATION.md).
