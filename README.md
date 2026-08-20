# Microsoft TTS Reader

A synchronized read-aloud WebExtension for Microsoft Edge and Firefox.

The reader now has two TTS backends:

- **Browser / local speech** through the standard Web Speech `speechSynthesis` API. Edge exposes its Online/Natural voices here; Firefox exposes the local/system voices available to it.
- **Microsoft Azure Speech** through the official browser Speech SDK in the Firefox build, giving Firefox access to Microsoft's large Azure neural voice catalog while preserving word-synchronized highlighting.

## Features

- Starts reading near the current viewport.
- Synchronized word and sentence highlighting.
- Click-to-seek can be disabled completely so the extension does not intercept page clicks.
- Pause/resume, stop, speed, colors, auto-scroll, draggable/minimizable toolbar.
- Live voice search across name, locale, provider, Azure short name, and styles.
- Editable fields and rich-text editors are hard-excluded from click-to-seek and page extraction.
- Settings persist in extension-local storage.

## Edge

The repository root remains directly loadable as an unpacked Edge extension:

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository.
4. Reload the extension after pulling changes, then refresh the webpage.

The root build uses browser-provided voices. In Edge that includes Online/Natural voices when Edge makes them available.

## Firefox — local + Azure voices

Install the pinned Microsoft Speech SDK and build the Firefox package:

```powershell
npm install
npm run build:firefox
```

Then:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `dist/firefox/manifest.json`.
4. Open a webpage and click the extension action.

Firefox local voices appear immediately. To add Azure voices, expand **Azure voices** in the toolbar, enter your Azure Speech region and subscription key, and click **Load**.

See [`docs/FIREFOX.md`](docs/FIREFOX.md) for the Firefox/Azure workflow.

## Cross-browser manifest

Manifest V3 uses both background declarations:

```json
"background": {
  "scripts": ["src/background.js"],
  "service_worker": "src/background.js"
}
```

Current Chromium uses the service worker, while Firefox uses the background script fallback.

## Development

```powershell
npm test
npm run check
npm run build:firefox
```

The Azure browser SDK dependency is pinned to `microsoft-cognitiveservices-speech-sdk@1.51.0`. The generated `dist/` directory and `node_modules/` are intentionally ignored.

## Layout

```text
manifest.json
scripts/
  build-firefox.mjs
src/
  background.js
  content/
    namespace.js
    editable-guard.js
    text-model.js
    highlighter.js
    speech-engine.js
    azure-speech-engine.js
    toolbar.js
    reader.js
    content-script.js
    content.css
tests/
docs/
  FIREFOX.md
```
