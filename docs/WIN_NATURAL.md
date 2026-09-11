# Windows Natural backend

The optional `[WIN-NATURAL]` backend is implemented in
`src/content/win-natural-engine.js` and `native/win-natural/`. It is separate
from `[ONLINE]` Edge/Azure Read Aloud and `[WIN-LEGACY]` Web Speech/
`chrome.tts`.

## Target-machine setup

1. Build the persistent x64 host:

   ```powershell
   dotnet publish native/win-natural/WinNaturalHost.csproj -c Release -r win-x64 --self-contained false
   ```

   The target needs the .NET 10 Windows Desktop Runtime.

2. Install/register only the x64 NaturalVoiceSAPIAdapter v0.2.4 files using
   the adapter's documented elevated registration procedure.

3. Point `HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator\NarratorVoicePath`
   to the compatible extracted Aria v2 `1.0.1.0` directory. For an offline
   test, use `NoEdgeVoices=1`, `NoAzureVoices=1`, and `NoNarratorVoices=0`.
   Do not install, replace, or downgrade the current Store Natural packages.

4. Register the per-user Edge Native Messaging host for the unpacked extension:

   ```powershell
   .\native\win-natural\install-native-host.ps1 -ExtensionId <extension-id>
   ```

   The script writes only
   `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural`.
   Remove that registration with `uninstall-native-host.ps1`.

The helper advertises only SAPI tokens whose IDs begin with `Local-`; this is
the adapter token family and prevents legacy David/Mark/Zira from entering the
Natural catalog.

## Verified on this machine

- Store Aria: `1.0.8.0`, status `Ok`, untouched.
- x64 adapter token: present.
- x86 adapter token: absent.
- Native Messaging manifest: installed per-user for extension ID
  `gfeeggciegdnlpdmebfjmahboogkilhi`.
- Helper handshake: protocol `1`, architecture `x64`.
- Advertised Natural voices: exactly `Microsoft Aria`, ID `Local-aria-v2`,
  locale `en-US`.
- Ethernet was disabled during synthesis and restored to `Up` afterward.
- WAV output was valid RIFF, mono, 16-bit, 22050 Hz PCM.
- Persistent-helper runs: 430.10 ms / 4 boundaries, 78.75 ms / 4 boundaries,
  and 359.63 ms / 23 boundaries for a paragraph. All used the same helper
  process; the second run demonstrates warm reuse.

The native helper test produced WAV files under the proof workspace and used
SAPI `SpeakProgress` events for the reported word timing. The repository test
suite passes (`86/86`) and `npm run check` passes.

The final interactive browser smoke test could not be driven in this
environment: the configured Windows Computer Use bridge was unavailable and
direct Edge launch was rejected by the execution policy. The extension-side
catalog, event routing, playback clock, highlighting, live rate/volume, and
cancel paths are covered by source checks/unit tests, but selecting Aria in a
visible Edge toolbar still needs manual QA or an environment with browser UI
automation enabled.
