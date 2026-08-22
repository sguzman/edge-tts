# Edge Natural TTS

A Microsoft Edge extension that turns normal webpages into a synchronized read-aloud experience using Edge's online Natural voices.

## Current behavior

- Click the extension action to inject the reader into the current tab and start reading near the current viewport.
- Uses Edge's `SpeechSynthesis` voices and prefers voices whose names contain `Natural` or `Online`.
- Highlights the currently spoken word and sentence using the CSS Custom Highlight API.
- Adjacent short paragraphs are aggregated into a logical speech batch so the reader can plan continuous playback across paragraph boundaries.
- The **Batch target** control is configurable from 400 to 2400 characters and persists with the other reader settings. The default is 1200 characters.
- Online/Natural voices are transported as short internal utterances capped at 175 characters, matching Chromium Read Aloud's own safety limit for remote voices. The configured Batch target does not enlarge these browser-level requests.
- Long playback is self-healing: stalled or prematurely-ended utterances recover from the last safe cursor, and repeated boundary-less failures cannot deadlock the rest of the document.
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

## Paragraph batching and transport chunking

The Batch target and the browser utterance size are intentionally different layers.

The reader first builds a logical batch:

- if the current paragraph already meets the configured **Batch target**, it can form the batch by itself;
- if it is short, following readable paragraphs are appended until the target is reached;
- paragraph boundaries remain represented in the batch so model position, seeking, and sentence highlighting continue across the combined material.

The logical batch is then broken into browser-safe transport utterances. Chromium's own Read Anything / Read Aloud implementation caps remote voices at 175 characters because of a TTS engine timeout bug on overly long remote text. Edge Natural/Online voices therefore use the same 175-character ceiling here, regardless of whether the Batch target is 400 or 2400 characters.

This means increasing the Batch target controls how much adjacent material the reader plans as one continuous unit; it no longer creates a giant remote `SpeechSynthesisUtterance`.

## Playback recovery

Web Speech boundary callbacks are useful for word highlighting but are not treated as infallible transport state.

The recovery policy is:

1. keep remote utterances short enough to avoid Chromium's known long-text timeout path in the first place;
2. provisionally commit the first token when audio starts so a boundary-less utterance still has a model cursor;
3. detect extended periods with no further word-boundary progress;
4. distinguish a genuine `end` from a suspiciously early termination without replaying the last confirmed token;
5. retry a failed cursor with a smaller recovery request;
6. as an absolute last resort, skip one irrecoverable token rather than deadlocking the rest of the document.

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
    reliable-speech-engine.js
    toolbar.js
    reader.js
    reliable-reader.js
    content-script.js
    content.css
tests/
docs/
```

See `docs/ARCHITECTURE.md` for the component boundaries.
