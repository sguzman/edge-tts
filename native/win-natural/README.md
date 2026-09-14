# Gate 1 Windows Natural diagnostic host

This is transport infrastructure only. It keeps a persistent x64 Native
Messaging process open and exposes only `hello` and `voices`. Enumeration is
filtered to SAPI voice IDs beginning with `Local-`, so ordinary Windows
legacy voices are not advertised.

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
