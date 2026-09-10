# Direct Natural-voice audio

Starting with 0.4.0, Edge Natural TTS has two playback transports.

## Natural / Online voices

Natural voices use Microsoft Edge's Read Aloud consumer speech endpoint directly. The extension requests normal-rate synthesis and receives:

- `audio-24khz-48kbitrate-mono-mp3` audio frames;
- WordBoundary metadata with 100-nanosecond audio offsets;
- a terminal `turn.end` message.

The MP3 is assembled into a Blob and played through an `HTMLAudioElement`. Playback speed is therefore a client-side media control rather than an SSML synthesis-rate request. The audio element keeps pitch preservation enabled where Chromium supports it.

Word highlighting follows `HTMLMediaElement.currentTime`. This is intentionally media time: it remains on the source-audio timeline while `playbackRate` controls how quickly that timeline advances. Returned word offsets therefore remain valid when speed changes.

The direct player is routed through Web Audio when available:

```text
MP3 Blob
  -> HTMLAudioElement (playbackRate, preservesPitch)
  -> MediaElementAudioSourceNode
  -> GainNode
  -> destination
```

This allows Natural-voice gain above 100%. The UI currently exposes 0-200% gain and 0.5x-8x playback speed.

## Local Windows voices

Local voices continue to use `SpeechSynthesisUtterance` because the browser does not expose their synthesized audio bytes. Their speed is still whatever range that local Web Speech engine honors, and `SpeechSynthesisUtterance.volume` remains limited to 0-100%.

## Read Aloud protocol

The direct transport follows the same consumer protocol used by current `edge-tts` implementations:

- endpoint: `speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`;
- trusted Edge client token;
- `Sec-MS-GEC` SHA-256 token derived from Windows file time rounded to five-minute intervals;
- current compatible `Sec-MS-GEC-Version` string;
- `speech.config` requesting MP3 and WordBoundary metadata;
- SSML with synthesis prosody fixed at `rate='+0%'`, `volume='+0%'`, and `pitch='+0Hz'`.

The extension requests host access only to `speech.platform.bing.com`; it still declares no automatic page content scripts and does not gain broad host-page access.

The consumer Read Aloud endpoint is not the official Azure Speech SDK/API and can change independently. Protocol constants are kept in `src/content/direct-audio-engine.js` so future Microsoft handshake changes are isolated.
