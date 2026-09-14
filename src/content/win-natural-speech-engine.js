(function attachWinNaturalSpeechEngine(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.SpeechEngine && api.WinNaturalSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.WinNaturalSpeechEngine;
    root.EdgeTtsExtension.WinNatural = api;
    root.EdgeTtsExtension.WinNaturalPlaybackAvailable = true;
  }
})(globalThis, function createWinNaturalSpeechEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;
  const isWinNaturalVoice = root.EdgeTtsExtension?.LocalTts?.isWinNaturalVoice ||
    ((voice) => voice?.__edgeTtsSource === "win-natural");
  const MAX_WAV_BYTES = 8 * 1024 * 1024;
  const SILENT_UNLOCK_WAV =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA";

  function textForSegments(segments) {
    return (segments || []).reduce((text, segment, index, list) => {
      if (index === 0) return String(segment?.text || "");
      const previous = list[index - 1];
      const separator = previous?.blockIndex !== segment?.blockIndex ? "\n\n" : " ";
      return `${text}${separator}${String(segment?.text || "")}`;
    }, "");
  }

  function bytesFromBase64(value) {
    if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error("Native Windows Natural response contained malformed audio.");
    }
    const binary = root.atob(value);
    if (binary.length <= 0 || binary.length > MAX_WAV_BYTES) {
      throw new Error("Native Windows Natural response exceeded the WAV limit.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  if (!BaseSpeechEngine) {
    return { WinNaturalSpeechEngine: null, bytesFromBase64, textForSegments };
  }

  class WinNaturalSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.nativeSessionMode = false;
      this.nativeAudio = null;
      this.nativeObjectUrl = "";
      this.nativeRequest = null;
      this.nativeSerial = 0;
      this.nativeStarted = false;
    }

    _ensureAudioElement() {
      if (this.nativeAudio) return this.nativeAudio;
      const audio = root.document?.createElement?.("audio") || new root.Audio();
      audio.preload = "auto";
      audio.preservesPitch = true;
      if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
      this.nativeAudio = audio;
      return audio;
    }

    prepareNativePlayback(voice) {
      if (!isWinNaturalVoice(voice)) return false;
      const audio = this._ensureAudioElement();
      audio.muted = true;
      audio.src = SILENT_UNLOCK_WAV;
      audio.load?.();
      const unlock = audio.play?.();
      unlock?.catch?.((error) => {
        console.debug("Edge Natural TTS Windows Natural audio unlock was rejected.", error);
      });
      audio.pause?.();
      audio.muted = false;
      audio.removeAttribute?.("src");
      audio.load?.();
      return true;
    }

    prepareDirectPlayback(voice) {
      if (isWinNaturalVoice(voice)) return this.prepareNativePlayback(voice);
      return super.prepareDirectPlayback?.(voice) || false;
    }

    _revokeObjectUrl() {
      if (!this.nativeObjectUrl) return;
      try {
        root.URL?.revokeObjectURL?.(this.nativeObjectUrl);
      } catch (_error) {}
      this.nativeObjectUrl = "";
    }

    _resetNativeState({ keepMode = false } = {}) {
      const audio = this.nativeAudio;
      if (audio) {
        audio.onplaying = null;
        audio.onended = null;
        audio.onerror = null;
        try {
          audio.pause?.();
          audio.removeAttribute?.("src");
          audio.load?.();
        } catch (_error) {}
      }
      this._revokeObjectUrl();
      this.nativeRequest = null;
      this.nativeStarted = false;
      this.nativeSessionMode = keepMode;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentOptions = null;
    }

    _failNative(generation, message) {
      if (generation !== this.generation) return;
      this._resetNativeState();
      this.onError?.(new Error(message));
    }

    _finishNative(generation) {
      if (generation !== this.generation || !this.nativeSessionMode) return;
      this._resetNativeState();
      this.onEnd?.();
    }

    _startNativeAudio(generation, wavBase64) {
      if (generation !== this.generation || !this.nativeSessionMode) return;
      let bytes;
      try {
        bytes = bytesFromBase64(wavBase64);
      } catch (error) {
        this._failNative(generation, error.message);
        return;
      }

      const audio = this._ensureAudioElement();
      this._revokeObjectUrl();
      this.nativeObjectUrl = root.URL.createObjectURL(new root.Blob([bytes], { type: "audio/wav" }));
      audio.src = this.nativeObjectUrl;
      audio.muted = false;
      audio.onplaying = () => {
        if (generation !== this.generation || this.nativeStarted) return;
        this.nativeStarted = true;
        const startedAt = root.performance?.now?.() ?? Date.now();
        this.onStart?.(this.currentChunks?.[0]?.segments?.[0], Math.max(0, startedAt - this.requestedAt));
      };
      audio.onended = () => this._finishNative(generation);
      audio.onerror = () => this._failNative(generation, "Windows Natural audio playback failed.");
      audio.load?.();
      Promise.resolve(audio.play?.()).then(() => {
        if (generation !== this.generation || this.nativeStarted) return;
        this.nativeStarted = true;
        const startedAt = root.performance?.now?.() ?? Date.now();
        this.onStart?.(this.currentChunks?.[0]?.segments?.[0], Math.max(0, startedAt - this.requestedAt));
      }).catch((error) => this._failNative(generation, `Windows Natural audio could not start: ${error?.message || error}`));
    }

    cancel() {
      if (this.nativeSessionMode || this.nativeRequest) {
        this.generation += 1;
        this._resetNativeState();
        return;
      }
      return super.cancel?.();
    }

    abandon() {
      if (this.nativeSessionMode || this.nativeRequest) {
        this.generation += 1;
        this._resetNativeState();
        return;
      }
      return super.abandon?.();
    }

    pause() {
      if (this.nativeSessionMode) {
        this.nativeAudio?.pause?.();
        return;
      }
      return super.pause?.();
    }

    resume() {
      if (this.nativeSessionMode) {
        void this.nativeAudio?.play?.();
        return;
      }
      return super.resume?.();
    }

    isPaused() {
      if (this.nativeSessionMode) return Boolean(this.nativeAudio?.paused);
      return super.isPaused?.() || false;
    }

    isSpeaking() {
      if (this.nativeSessionMode) {
        return Boolean(this.nativeStarted && this.nativeAudio && !this.nativeAudio.paused);
      }
      return super.isSpeaking?.() || false;
    }

    speak(block, startSegmentIndex, options = {}) {
      if (!isWinNaturalVoice(options.voice)) {
        if (this.nativeSessionMode || this.nativeRequest) this.cancel();
        return super.speak(block, startSegmentIndex, options);
      }

      const voiceId = String(options.voice?.nativeVoiceId || "").trim();
      if (!/^Local-/i.test(voiceId)) {
        this.onError?.(new Error("Windows Natural voice has no valid Local-* SAPI token."));
        return;
      }
      const segments = Array.isArray(block?.segments)
        ? block.segments.slice(Math.max(0, Number(startSegmentIndex) || 0))
        : [];
      const text = textForSegments(segments);
      if (!text) {
        this.onEnd?.();
        return;
      }

      if (this.nativeSessionMode || this.nativeRequest) this.cancel();
      else super.cancel?.();

      this.nativeSessionMode = true;
      this.nativeStarted = false;
      this.generation += 1;
      const generation = this.generation;
      this.currentChunks = [{ segments }];
      this.currentChunkIndex = 0;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      const requestId = `win-natural-${Date.now()}-${++this.nativeSerial}`;
      this.nativeRequest = { requestId, generation };

      Promise.resolve(root.chrome?.runtime?.sendMessage?.({
        type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE",
        requestId,
        voiceId,
        text
      })).then((response) => {
        if (generation !== this.generation || this.nativeRequest?.requestId !== requestId) return;
        this.nativeRequest = null;
        if (!response?.accepted || typeof response.wavBase64 !== "string") {
          this._failNative(generation, response?.error || "Windows Natural synthesis was rejected.");
          return;
        }
        this._startNativeAudio(generation, response.wavBase64);
      }).catch((error) => {
        if (generation !== this.generation || this.nativeRequest?.requestId !== requestId) return;
        this.nativeRequest = null;
        this._failNative(generation, `Windows Natural synthesis failed: ${error?.message || error}`);
      });
    }
  }

  return { WinNaturalSpeechEngine, bytesFromBase64, textForSegments };
});
