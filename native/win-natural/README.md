# Gate 1 Windows Natural diagnostic host

This is transport infrastructure only. It keeps a persistent x64 Native
Messaging process open and exposes only `hello` and `voices`. Enumeration is
filtered to SAPI voice IDs beginning with `Local-`, so ordinary Windows
legacy voices are not advertised.

The adapter token ID is discovery-path dependent. The previous POC exposed
`Local-aria-v2`, while the adapter's documented default `NarratorVoices`
directory exposes `Local-NarratorVoices`. Treat the `Local-` prefix plus the
voice identity (`Microsoft Aria`, `en-US`) as the logical match and preserve
the actual SAPI token ID unchanged for later native requests.

Build:

```powershell
dotnet publish native/win-natural/WinNaturalHost.csproj -c Release -r win-x64 --self-contained false
```

Install for the development unpacked extension (the ID must be supplied
explicitly):

```powershell
powershell -ExecutionPolicy Bypass -File .\native\win-natural\install-native-host.ps1 -ExtensionId <development-extension-id>
```

The script registers HKCU\Software\Microsoft\Edge\NativeMessagingHosts and
does not change the Windows voice package or stable profile.

If Edge cannot see the adapter's per-user `NarratorVoicePath` configuration,
the Gate 1 fallback is a directory junction from the adapter's x64 default
directory to the already-working extracted voice package. For the verified
machine this was:

```powershell
New-Item -ItemType Junction `
  -Path 'C:\Users\guzma\Documents\Codex\2026-09-10\goal-prove-a-usable-offline-windows\work\adapter-v0.2.4\x64\NarratorVoices' `
  -Target 'C:\Users\guzma\Documents\Codex\2026-09-10\goal-prove-a-usable-offline-windows\work\aria-v2'
```

This does not copy or move the package. Remove only the junction to roll it
back:

```powershell
Remove-Item -LiteralPath 'C:\Users\guzma\Documents\Codex\2026-09-10\goal-prove-a-usable-offline-windows\work\adapter-v0.2.4\x64\NarratorVoices'
```
