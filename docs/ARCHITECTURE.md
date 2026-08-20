# Architecture

## Goal

The extension should feel like a page-native reading layer without becoming part of the host application's runtime:

1. Start from the part of the page the user is currently looking at.
2. Speak with Edge's best available online/Natural voice.
3. Keep the current spoken word and sentence visually synchronized.
4. Optionally let a click on readable text seek to that word.
5. Continue forward through readable content without continuously watching the page.

## Performance safety invariants

These are architectural rules, especially for large SPAs such as ChatGPT:

- Do not install a document-wide `MutationObserver` for text discovery or editable detection.
- Do not rescan the document because of an arbitrary page click.
- Do not mutate host-page DOM to mark editors or readable text.
- Do not perform layout reads for every candidate while building the text model.
- Do not perform auto-scroll geometry work on every word boundary.
- Click-to-seek is opt-in; when disabled there is no document click listener.
- Dynamic content is refreshed explicitly through the toolbar rather than continuously watched.

## Components

### `background.js`

Owns the Edge browser action and sends a toggle message to the active tab. It contains no reading logic.

### `text-model.js`

Converts readable DOM blocks into a stable speech model. Each spoken token records its offset in synthesized text plus the originating DOM `Text` node and source offsets. This mapping enables synchronized highlighting and optional click-to-seek without wrapping or replacing page text.

The generic profile favors semantic block elements (`p`, headings, list items, blockquotes, table cells, and similar elements) inside the most likely article/main root.

The ChatGPT profile is deliberately narrower: on `chatgpt.com` and `chat.openai.com`, it prefers only user and assistant message containers. The composer, sidebar, navigation, and app chrome are excluded.

Editable surfaces (`input`, `textarea`, `contenteditable`, textbox roles, ProseMirror/Lexical/CodeMirror-style editors, and similar controls) are rejected synchronously during model construction. No observer is used.

### `speech-engine.js`

Owns `window.speechSynthesis` and `SpeechSynthesisUtterance` lifecycle. It ranks Natural/Online voices first, chunks long text, converts browser boundary character indexes back into model segments, and isolates cancellation with a generation counter so stale events cannot advance playback.

### `highlighter.js`

Uses the CSS Custom Highlight API when available. It avoids DOM wrapping, which can break framework hydration, selection, layout, and event delegation. Highlight CSS is injected lazily when highlighting first begins. Auto-scroll geometry checks are throttled.

### `toolbar.js`

Injected control surface for pause/resume, stop, explicit text refresh, searchable voice selection, speed, highlight colors, auto-scroll, click-to-seek, and status. It is marked with `data-edge-tts-ui` so extraction and seeking ignore it.

### `reader.js`

Orchestrates the text model, speech engine, highlighter, toolbar, settings, block progression, and optional click-to-seek. It owns the explicit refresh operation for dynamic pages.

## Click-to-seek

Click-to-seek is disabled by default. When disabled, no captured document click listener is installed.

When enabled, a captured click is translated to a DOM caret using `caretPositionFromPoint` or Chromium's `caretRangeFromPoint`. Only text nodes already present in the current model can be used as seek targets. A miss is ignored; it never triggers a model rebuild.

Editable controls and the extension toolbar are always ignored.

## Natural voice selection

The extension does not hardcode a particular display name because Edge's voice catalog varies by language, platform, browser version, policy, and connectivity. Ranking is:

1. exact saved voice,
2. voice name containing `Natural` or `Online`,
3. exact document/browser language,
4. same base language,
5. Microsoft-branded voice,
6. browser default.

The reader listens for `voiceschanged` so late-arriving online voices can replace an initial local-only list.

## Dynamic pages

The model is built when the reader starts, when Start is pressed after stopping, or when **Refresh text** is pressed. This is intentional. Continuous DOM observation is not acceptable for mutation-heavy applications.

Future per-site profiles should follow the same rule: narrow the extraction scope rather than continuously monitoring the whole site.

## Later work

- More per-site reading profiles and content masks.
- Selection-only and element-only reading modes.
- Skip rules for citations, code, footnotes, and repeated navigation.
- Voice previews and favorites.
- Better cross-block speech continuity without sacrificing pause/resume reliability.
- Iframe and Shadow DOM coverage where practical.
