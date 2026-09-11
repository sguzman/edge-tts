# Edge Natural TTS

A Microsoft Edge extension that turns normal webpages into a synchronized read-aloud experience using Edge's online Natural voices and Windows-local voices.

## Current behavior

- Click the extension action to inject the reader into the current tab and start reading near the current viewport.
- **Online voices use a direct Microsoft Edge Read Aloud transport:** the extension receives MP3 audio plus word-boundary metadata and plays the audio itself.
- **Windows Natural voices are optional and offline:** the x64 native helper uses SAPI plus NaturalVoiceSAPIAdapter, returning WAV audio and SAPI word-boundary timing.
- **Windows-local discovery merges two catalogs:** page `speechSynthesis.getVoices()` plus extension `chrome.tts.getVoices()`. A Windows voice missing from Web Speech can therefore still appear and play through the extension-level Windows TTS backend.
- Voice names are visibly prefixed with **[WIN-NATURAL]**, **[WIN-LEGACY]**, or **[ONLINE]**, and the toolbar filters All voices / Windows Natural / Windows Legacy / Online.
- Natural synthesis is requested at normal prosody; the primary **Speed** control is client-side playback speed, currently 0.5x–8x.
- Natural/direct audio has a **Volume** control from 0–200% using Web Audio gain. Local Windows voices remain limited to the OS/browser TTS volume range.
- Highlights the currently spoken word and sentence using Microsoft word timing metadata for direct audio, Web Speech boundary events, or `chrome.tts` word events for Windows-local fallback voices.
- Adjacent short paragraphs are aggregated into a logical speech batch so the reader can plan continuous playback across paragraph boundaries.
- The **Batch target** control is configurable from 400 to 2400 characters and persists with the other reader settings. The default is 1200 characters.
- Pause/resume, stop, voice filtering, playback speed, volume, highlight colors, and auto-scroll live in a movable/minimizable toolbar.
- Each tab keeps an independent reader session. The existing browser-audio ownership coordinator remains in place while the direct transport is validated.
- Click-to-seek is optional and is **off by default**. When disabled, the extension does not install a page click listener.
- Editable controls and rich-text editors are excluded without watching or mutating the page DOM.
- Use **Refresh text** to explicitly re-scan a dynamic page after its content changes.

## Voice catalog and backends

The reader distinguishes voice **identity/discovery** from voice **playback transport**.

For local voices, the extension first reads the normal page Web Speech catalog. It also asks the extension-level `chrome.tts` API for OS-provided voices. Catalog entries with the same voice name and locale are deduplicated, preferring the Web Speech object when both APIs expose the same voice. Remote `chrome.tts` entries are not imported into the Windows-local fallback catalog.

This produces three user-facing classes:

```text
[WIN-NATURAL] Locally exposed NaturalVoiceSAPIAdapter voice
[WIN-LEGACY]  Windows / OS voice through Web Speech or chrome.tts
[ONLINE]      Edge Online / Natural voice
```

The toolbar's **Voice class** filter can show all voices, Windows Natural, Windows Legacy, or Online. Text search composes with that class filter.

A local voice already exposed by `speechSynthesis` keeps the existing Web Speech playback path. A local voice found only through `chrome.tts` is spoken by the extension-level Windows TTS backend; its start/word/end events are bridged back into the tab so the existing reader cursor and highlighter continue to work.

## Direct Natural-voice audio

For Natural / Online voices the extension no longer asks `SpeechSynthesisUtterance.rate` to do the main speed work. It talks to Microsoft Edge's consumer Read Aloud speech endpoint, requests `audio-24khz-48kbitrate-mono-mp3` at normal synthesis prosody, collects the returned MP3 frames and WordBoundary metadata, and creates its own media player.

The resulting pipeline is:

```text
page text
  -> Edge Read Aloud synthesis at normal prosody
  -> MP3 + word timing metadata
  -> HTMLAudioElement (playbackRate, preservesPitch)
  -> Web Audio GainNode
  -> speakers
```

This separates **voice synthesis rate** from **playback speed**. Changing the Speed slider during direct Natural playback changes `HTMLAudioElement.playbackRate` without making a new TTS request. Changing Volume mutates the gain stage without resynthesizing. Because highlighting follows the media element's source-audio clock, the returned word offsets remain usable even as playback speed changes.

The direct consumer endpoint is the Edge Read Aloud service, not the official Azure Speech SDK/API and does not require an Azure subscription key. It is an undocumented consumer protocol and may change independently; its handshake is therefore isolated in `src/content/direct-audio-engine.js`.

See `docs/DIRECT_AUDIO.md` for the protocol and playback architecture.

## Multi-tab sessions

Reader state is tab-local: each tab keeps its own text model, cursor, HUD, paused/stopped state, and recovery timers.

The browser/OS local speech transport is shared enough that independent tabs cannot safely leave competing utterances queued or paused inside it. The background worker therefore arbitrates browser speech ownership. Starting or resuming a tab explicitly claims ownership; if another tab currently owns it, that older session is canceled at the browser layer and left locally paused at its last cursor. It never auto-resumes merely because another tab changes the shared speech engine.

Direct MP3 Natural playback is itself tab-local and no longer depends on `window.speechSynthesis` for audio. The existing ownership lease remains as a conservative session policy while direct playback is validated. Once stable, it can be relaxed for direct-audio sessions without changing the safety rule for local voices.

## Zero-idle page cost

The extension does not declare automatic `content_scripts` or broad page host permissions. Reader JavaScript and CSS are injected only after you explicitly click the extension action on a tab, using `activeTab` and `scripting` permissions.

Direct synthesis adds narrowly scoped host access only for `speech.platform.bing.com` over HTTPS/WSS. It does not grant access to arbitrary webpages and does not cause the reader to run before you click the extension.

Before that first click, the extension has no JavaScript, CSS, DOM observers, event listeners, or text model running inside the webpage.

## ChatGPT safety profile

ChatGPT is a large, continuously mutating web application, so the reader deliberately avoids treating the whole application DOM as an article.

On `chatgpt.com` and `chat.openai.com`, the text model prefers only message containers marked as user or assistant messages. Sidebar controls, the composer, navigation, and other app chrome are not part of the reading model.

The extension also does **no background MutationObserver scanning**. Model building happens only when the reader starts, when Start is pressed after stopping, or when **Refresh text** is pressed.

## Paragraph batching

The reader first builds a logical batch:

- if the current paragraph already meets the configured **Batch target**, it can form the batch by itself;
- if it is short, following readable paragraphs are appended until the target is reached;
- paragraph boundaries remain represented in the batch so model position, seeking, and sentence highlighting continue across the combined material.

For direct Natural playback, that logical material is split only as needed for the Read Aloud service, then the returned MP3 frames are assembled for client playback. Local Windows voices use the existing reader batching while their selected local transport emits progress events back into the same model cursor.

## Playback recovery

Local voice playback retains the existing reader-level recovery machinery for stalled or interrupted playback.

Direct Natural playback instead owns the media object and its playback clock. Microsoft WordBoundary metadata drives highlighting, while direct network/media failures are reported distinctly from legacy browser/OS TTS failures.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open a normal webpage and click the extension icon.

After pulling source changes, click **Reload** on the extension card. Because injection is on demand, newly opened/reloaded pages remain untouched until you click the extension action on that tab.

## Why this works without an Azure key

Microsoft Edge's Read Aloud consumer service exposes the Natural voice audio used by Edge. The extension implements the current browser-compatible handshake directly and receives MP3 frames plus word timing metadata. No Azure SDK, Azure subscription key, Firefox build, or separate local backend is required for Natural voices.

Windows-local fallback voices use Edge's extension `chrome.tts` API, which delegates to the operating system's TTS support.

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
    direct-audio-engine.js
    local-tts-engine.js
    toolbar.js
    voice-ui.js
    reader.js
    reliable-reader.js
    failsafe-reader.js
    audio-controls.js
    startup-fastpath.js
    content-script.js
    content.css
tests/
docs/
  DIRECT_AUDIO.md
```

See `docs/ARCHITECTURE.md` for the component boundaries.
# Optional offline Windows Natural backend

The extension can use a locally exposed Windows Natural voice through the
optional x64 NativeVoiceSAPIAdapter arrangement. This path is deliberately
separate from the existing `[ONLINE]` Edge/Azure Read Aloud backend and the
`[WIN-LEGACY]` `chrome.tts`/Web Speech backend.

Build the persistent helper from `native/win-natural/WinNaturalHost.csproj`:

```powershell
dotnet publish native/win-natural/WinNaturalHost.csproj -c Release -r win-x64 --self-contained false
```

On the target machine, install/register the compatible x64 adapter and
extracted Natural voice package according to its documented rollback procedure.
Then run `native/win-natural/install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID`
and reload the unpacked extension.
The install script only creates a per-user Edge Native Messaging registration;
it does not install or alter voice packages or adapter registration. Remove it
with `native/win-natural/uninstall-native-host.ps1`.

The helper returns WAV audio and SAPI `SpeakProgress` word boundaries. Playback
uses the same media-clock path as direct audio, so rate and volume changes do
not resynthesize the current utterance. The compatible extracted voice remains
an external prerequisite and is intentionally not committed to this repo.

The helper advertises only adapter `Local-*` SAPI token IDs. This keeps legacy
David/Mark/Zira voices on the existing `[WIN-LEGACY]` path and prevents them
from being mislabeled as `[WIN-NATURAL]`. The Store Natural packages remain
untouched; another machine needs the compatible extracted Aria v2 package,
the x64 adapter registration, and the .NET 10 Windows Desktop Runtime.
