# Firefox build

Firefox can use two voice sources in this project:

1. **Local/browser voices** exposed by Firefox through the standard Web Speech `speechSynthesis` API. On Windows these normally include Windows-installed speech voices that Firefox exposes.
2. **Microsoft Azure Speech voices** through the official Microsoft Cognitive Services Speech SDK.

## Build

The checked-in source remains directly loadable in Edge and can also be loaded in Firefox for local/browser voices. The Azure-capable Firefox build vendors Microsoft's browser Speech SDK into a generated extension directory.

```powershell
npm install
npm run build:firefox
```

The result is:

```text
dist/firefox/
```

## Load temporarily in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Open `dist/firefox/manifest.json`.
4. Open a normal webpage and click the extension toolbar action.

Reload the temporary add-on after rebuilding.

## Azure voices

Open **Azure voices** in the reader toolbar, enter the Azure Speech **region** (for example `eastus`) and your Speech subscription key, then click **Load**.

The extension calls the official Azure Speech SDK to enumerate the voice catalog. Azure voices are merged into the same searchable dropdown as local voices and are labeled `[Azure]`.

The key is stored in extension-local storage so it survives reloads. Use **Forget saved key** to remove it.

Azure synthesis uses SDK word-boundary events plus the browser audio player's current playback time to keep highlighting synchronized to actual playback rather than highlighting words as soon as the server reports them.

## Voice labels

- `[Local]` — a voice returned by Firefox/Windows through `speechSynthesis.getVoices()`.
- `[Azure]` — a voice returned by the configured Azure Speech resource.
- `[Edge Online]` — an Edge Online/Natural voice when the same source is loaded in Microsoft Edge.

The filter searches voice name, locale, source/provider, Azure short name, and Azure styles.
