# Edge Natural TTS

A Microsoft Edge extension that turns normal webpages into a synchronized read-aloud experience using Edge's online Natural voices.

## Current behavior

- Click the extension action to inject and start the reader on the current tab.
- Uses Edge's `SpeechSynthesis` voices and prefers voices whose names contain `Natural` or `Online`.
- Highlights the currently spoken word and sentence using the CSS Custom Highlight API.
- Pause/resume, stop, voice filtering, playback speed, highlight colors, and auto-scroll live in a movable/minimizable toolbar.
- Click-to-seek is optional and is **off by default**. When disabled, the extension does not install a page click listener.
- Editable controls and rich-text editors are excluded without watching or mutating the page DOM.
- Use **Refresh text** to explicitly re-scan a dynamic page after its content changes.

## Zero-idle page cost

The extension does not declare `content_scripts` or broad `host_permissions`.

When you have not clicked the extension action on a tab, no Edge Natural TTS JavaScript or CSS is injected into that webpage. The background service worker is event-driven and does not run inside the page. The reader stack is injected only after an explicit action click using `activeTab` + `chrome.scripting`.

This is a hard performance boundary: merely having the extension enabled must not add page listeners, DOM scans, styles, speech subscriptions, or page-main-thread work to untouched tabs.

## ChatGPT safety profile

ChatGPT is a large, continuously mutating web application, so the reader deliberately avoids treating the whole application DOM as an article.

On `chatgpt.com` and `chat.openai.com`, the text model prefers only message containers marked as user or assistant messages. Sidebar controls, the composer, navigation, and other app chrome are not part of the reading model.

The extension also does **no background MutationObserver scanning**. Model building happens only when the reader starts, when Start is pressed after stopping, or when **Refresh text** is pressed.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open a normal webpage and click the extension icon.

After pulling source changes, click **Reload** on the extension card. Refresh any already-open webpage before testing idle performance so an older injected content-script instance cannot remain in that tab.

## Why this works without an Azure key

Microsoft Edge exposes its online Natural voice catalog through the standard Web Speech `SpeechSynthesis` API. The extension uses the browser-provided voices directly; it does not ship an Azure SDK, Azure key, Firefox build, or separate cloud backend.

## Performance rules

This project intentionally avoids background work on host pages:

- no automatic content-script injection;
- no broad host permission or always-on page access;
- no MutationObserver over the document;
- no automatic full-document rebuild from arbitrary page clicks;
- no `getBoundingClientRect()` calls for every candidate while constructing the text model;
- auto-scroll geometry checks are throttled rather than performed at every spoken word boundary;
- highlight CSS is created lazily only after highlighting actually begins.

`tests/idle-safety.test.js` protects the zero-idle contract and fails if automatic content scripts, broad host permissions, or document mutation monitoring are reintroduced.

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
