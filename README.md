# Edge Natural TTS

A Microsoft Edge extension that turns normal webpages into a synchronized read-aloud experience using Edge's online Natural voices.

## Current MVP

- Click the extension action to start reading near the current viewport.
- Uses the browser's `SpeechSynthesis` voices and prefers voices whose names contain `Natural` or `Online`.
- Highlights the currently spoken word using the CSS Custom Highlight API.
- While the reader is active, click readable page text to jump to that exact word and continue from there.
- Automatically advances through readable blocks on the page.
- Pause/resume, stop, voice selection, and playback speed controls live in a small page toolbar.
- Voice and speed preferences persist through `chrome.storage.local`.
- Press `Esc` to close the reader.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open a normal webpage and click the extension icon.

For `file://` pages, Edge also requires **Allow access to file URLs** on the extension details page.

## Why this works without an Azure key

Microsoft Edge can expose online Text-to-Speech voice fonts to web applications that use the Web Speech `SpeechSynthesis` API. Edge's policy documentation describes those online voices as higher-quality voice fonts backed by Azure Cognitive Services. The extension uses that browser-provided surface rather than shipping an Azure subscription key.

The reader listens for `SpeechSynthesisUtterance` boundary events. Each event provides a character index into the utterance, which is mapped back to the original DOM text node so the spoken word can be highlighted in sync.

## Important limitations

- Edge can disable online TTS through enterprise policy, so Natural/Online voices may not appear on managed installations.
- Browser-restricted pages such as `edge://` pages and extension-store pages do not allow ordinary content-script injection.
- Very unusual pages that render text in canvas/WebGL rather than DOM text are not readable by this approach.
- The first version reads the top-level document only; cross-origin iframe orchestration is intentionally deferred.
- Exact boundary behavior is voice/browser dependent. The intended target is Microsoft Edge's online Natural voices.

## Development

No build step and no runtime dependencies are required.

```bash
npm test
npm run check
```

The extension source is loaded directly from the repository.

## Layout

```text
manifest.json
src/
  background.js
  content/
    namespace.js
    text-model.js
    highlighter.js
    speech-engine.js
    toolbar.js
    reader.js
    content-script.js
    content.css
tests/
docs/
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the component boundaries and next implementation steps.
