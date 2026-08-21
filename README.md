# Edge Natural TTS

A Microsoft Edge extension that turns normal webpages into a synchronized read-aloud experience using Edge's online Natural voices.

## Current behavior

- Click the extension action to inject the reader into the current tab and start reading near the current viewport.
- Uses Edge's `SpeechSynthesis` voices and prefers voices whose names contain `Natural` or `Online`.
- Highlights the currently spoken word and sentence using the CSS Custom Highlight API.
- Adjacent short paragraphs are batched into a single speech request to avoid repeated online-voice startup latency. A sufficiently large paragraph stays on its own.
- The **Batch target** control is configurable from 400 to 2400 characters and persists with the other reader settings. The default is 1200 characters.
- Pause/resume, stop, voice filtering, playback speed, highlight colors, and auto-scroll live in a movable/minimizable toolbar.
- Click-to-seek is optional and is **off by default**. When disabled, the extension does not install a page click listener.
- Editable controls and rich-text editors are excluded without watching or mutating the page DOM.
- Use **Refresh text** to explicitly re-scan a dynamic page after its content changes.

## Zero-idle page cost

The extension does not declare automatic `content_scripts` or broad host permissions. Reader JavaScript and CSS are injected only after you explicitly click the extension action on a tab, using `activeTab` and `scripting` permissions.

Before that first click, the extension has no JavaScript, CSS, DOM observers, event listeners, or text model running inside the webpage.

## ChatGPT safety profile

ChatGPT is a large, continuously mutating web application, so the reader deliberately avoids treating the whole application DOM as an article.

On `chatgpt.com` and `chat.openai.com`, the text model prefers only message containers marked as user or assistant messages. Sidebar controls, the composer, navigation, and other app chrome are not part of the reading model.

The extension also does **no background MutationObserver scanning**. Model building happens only when the reader starts, when Start is pressed after stopping, or when **Refresh text** is pressed.

## Paragraph batching

Online Natural voices can incur noticeable startup latency each time a new `SpeechSynthesisUtterance` begins. The reader therefore builds a speech batch before synthesis:

- if the current paragraph already meets the configured **Batch target**, it is synthesized normally;
- if it is short, following readable paragraphs are appended until the target is reached;
- paragraph boundaries are retained as blank-line separators in the utterance so speech keeps a natural break;
- very large content is still chunked so pause/resume and seeking remain manageable.

Increasing the Batch target generally reduces gaps between tiny paragraphs at the cost of larger synthesis requests. Changing it while reading restarts from the current word with the new target.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open a normal webpage and click the extension icon.

After pulling source changes, click **Reload** on the extension card. Because injection is on demand, newly opened/reloaded pages remain untouched until you click the extension action on that tab.

## Why this works without an Azure key

Microsoft Edge exposes its online Natural voice catalog through the standard Web Speech `SpeechSynthesis` API. The extension uses the browser-provided voices directly; it does not ship an Azure SDK, Azure key, Firefox build, or separate cloud backend.

## Performance rules

This project intentionally avoids background work on host pages:

- no automatic content-script injection;
- no MutationObserver over the document;
- no automatic full-document rebuild from arbitrary page clicks;
- no `getBoundingClientRect()` calls for every candidate while constructing the text model;
- auto-scroll geometry checks are throttled rather than performed at every spoken word boundary;
- highlight CSS is injected lazily only after highlighting actually begins.

## Development

There is no build step and there are no runtime dependencies.

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

See `docs/ARCHITECTURE.md` for the component boundaries.
