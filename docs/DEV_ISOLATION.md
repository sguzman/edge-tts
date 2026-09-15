# Development Native Messaging isolation

The development branch uses a separate Native Messaging channel from stable.
Installing or uninstalling development must never overwrite stable's manifest,
payload, registry key, or authorization.

| Channel | Extension ID | Native host | Install root |
| --- | --- | --- | --- |
| Stable | `gfeeggciegdnlpdmebfjmahboogkilhi` | `com.sguzman.edge_tts.win_natural` | `%LOCALAPPDATA%\EdgeNaturalTts\native-host\stable` |
| Development | `gajodjkpikfgfbcobncfacbjeaekgefb` | `com.sguzman.edge_tts.win_natural.dev` | `%LOCALAPPDATA%\EdgeNaturalTts\native-host\development` |

The extension derives the host name from `chrome.runtime.id`. Stable and
development therefore cannot silently connect to one another's host. Unknown
IDs fail closed; tests may provide an explicit injected ID, but production does
not fall back to a shared host.

Each installer invocation requires `-Channel Stable` or `-Channel Development`
and an ID matching that channel. It creates only the selected channel's
registry key and manifest, with exactly one `allowed_origins` entry. The helper
is copied from the publish directory into that channel's owned `payload`
directory, so the installed host does not depend on a repository worktree or
on the other channel's payload.

Development setup example:

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\native\win-natural\install-native-host.ps1 `
  -Channel Development `
  -ExtensionId "gajodjkpikfgfbcobncfacbjeaekgefb"
```

The matching scoped removal is:

```powershell
powershell -ExecutionPolicy Bypass `
  -File .\native\win-natural\uninstall-native-host.ps1 `
  -Channel Development
```

These commands are documentation only for this repository change; no machine
registration is performed by the isolation work itself. A development install
is disposable and must not change stable state.
