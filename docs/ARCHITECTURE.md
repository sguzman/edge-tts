# Architecture

## Goal

The extension should feel like a page-native reading layer rather than a detached audio player:

1. Start from the part of the page the user is currently looking at.
2. Speak with Edge's best available online/Natural voice.
3. Keep the current spoken word visually synchronized.
4. Let a click on readable text seek immediately to that word.
5. Continue forward through the document without requiring manual selection.

## Components

### `background.js`

Owns the browser action. It sends a toggle message to the active tab. It deliberately contains no reading logic.

### `text-model.js`

Converts readable DOM blocks into a stable speech model. Each spoken token records both its offset in synthesized text and the originating DOM `Text` node plus source offsets. That dual mapping is what makes synchronized highlighting and click-to-seek possible without wrapping or replacing page text.

### `speech-engine.js`

Owns `window.speechSynthesis` and `SpeechSynthesisUtterance` lifecycle. It ranks Natural/Online voices first, creates utterance text from any segment offset, converts browser boundary character indexes back into model segments, and isolates cancellation with a generation counter so stale events cannot advance playback.

### `highlighter.js`

Uses the CSS Custom Highlight API when available. This avoids mutating the site's DOM, which is important because wrapping words in custom spans can break framework hydration, selection, layout, and event delegation. A normal browser selection is retained only as a compatibility fallback.

### `toolbar.js`

A small injected control surface for pause/resume, stop, voice selection, speed, and status. It is marked with `data-edge-tts-ui` so page-text extraction and click-to-seek ignore it.

### `reader.js`

Orchestrates the model, speech engine, highlighter, toolbar, settings, block progression, click-to-seek, and keyboard lifecycle.

## Reading model

The first version intentionally favors semantic block elements (`p`, headings, list items, blockquotes, table cells, and similar elements) instead of blindly reading `document.body.innerText`. It chooses the largest visible `article`, `main`, or `[role=main]` root when available.

## Click-to-seek

While active, a captured page click is translated to a DOM caret using `caretPositionFromPoint` or Chromium's `caretRangeFromPoint`. The caret's text node is looked up in the current speech model, then the closest token becomes the new speech start position.

Clicks that resolve to readable text are consumed so clicking linked text seeks instead of navigating. Clicks that do not resolve to readable text keep their normal page behavior.

## Natural voice selection

The extension does not hardcode a particular display name because Edge's voice catalog varies by language, platform, browser version, policy, and connectivity. The current ranking policy is:

1. exact saved voice,
2. voice name containing `Natural` or `Online`,
3. exact document/browser language,
4. same base language,
5. Microsoft-branded voice,
6. browser default.

The reader also listens for `voiceschanged` so late-arriving online voices can replace the initial local-only list.

## Next milestones

### 0.2 — reading quality

- Sentence-aware chunking for extremely long paragraphs.
- Better boilerplate rejection and article-root selection.
- MutationObserver-backed refresh for infinite-scroll/SPAs.
- Preserve a more precise restart point when changing speed or voice.
- Keyboard shortcuts for seek, speed, pause, and paragraph navigation.

### 0.3 — synchronization quality

- Instrument boundary timing and verify Natural voices across Edge versions.
- Add a timing fallback for voices that do not emit reliable word boundaries.
- Optional sentence highlighting plus stronger current-word styling.
- Better scroll-follow behavior that avoids layout jumps.

### 0.4 — page coverage

- Same-origin and cross-origin iframe coordination.
- Selection-only and element-only reading modes.
- PDF strategy investigation.
- Shadow DOM traversal where practical.

### Later

- Richer Speechify-style mini-player.
- Per-site reading profiles.
- Pronunciation substitutions.
- Skip rules for citations, code, footnotes, and repeated navigation.
- Voice previews and favorites.
- Optional Azure Speech SDK backend only if browser-provided Natural voices prove insufficient for boundary fidelity or availability.
