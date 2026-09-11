# Windows Natural Native Messaging host

This is an opt-in x64 helper for the `[WIN-NATURAL]` catalog. It talks Native
Messaging JSON framing on stdin/stdout, uses SAPI through `System.Speech`, and
returns WAV chunks plus `SpeakProgress` word boundaries. It does not install,
register, remove, or downgrade any Windows voice package.

Build on the target Windows machine with `dotnet publish -c Release -r win-x64
--self-contained false`. This requires the .NET 10 Windows Desktop Runtime on
the target machine. The host must be run beside the x64
NaturalVoiceSAPIAdapter v0.2.4 registration and the compatible extracted Aria
v2 package. The adapter and voice package remain external machine
prerequisites.

The adapter arrangement used by the proof of concept is x64-only: point
`HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator\NarratorVoicePath` at the
dedicated extracted Aria v2 directory, keep `NoNarratorVoices=0`, and set
`NoEdgeVoices=1` and `NoAzureVoices=1` while testing. Do not install or replace
the current Microsoft Store Aria package. The adapter's elevated x64
registration and its rollback must be performed using the adapter's own
documented installer/uninstaller; this repository does not automate that
system-level operation.

The Native Messaging script creates only the per-user Edge registration at
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural`.
Run `uninstall-native-host.ps1` to remove that key and manifest. It does not
touch SAPI registration, voice packages, or adapter configuration.
