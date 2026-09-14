(function attachLocalTtsEngine(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.SpeechEngine && api.LocalTtsSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.LocalTtsSpeechEngine;
    root.EdgeTtsExtension.LocalTts = api;
  }
})(globalThis, function createLocalTtsEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;
  const createUtteranceChunks = speechModule?.createUtteranceChunks;
  const segmentIndexForCharIndex = root.EdgeTtsExtension?.TextModel?.segmentIndexForCharIndex;

  function voiceKey(voice) {
    return `${String(voice?.name || "").trim().toLocaleLowerCase()}\u0000${String(
      voice?.lang || ""
    )
      .trim()
      .toLocaleLowerCase()}`;
  }

  function chromeVoiceToCatalogVoice(voice) {
    const name = String(voice?.voiceName || "").trim();
    if (!name || voice?.remote === true) return null;
    return {
      name,
      lang: String(voice?.lang || ""),
      localService: true,
      default: false,
      voiceURI: `chrome-tts:${name}`,
      __edgeTtsSource: "chrome-tts",
      chromeVoiceName: name,
      eventTypes: Array.isArray(voice?.eventTypes) ? [...voice.eventTypes] : [],
      extensionId: voice?.extensionId || null
    };
  }

  function mergeVoiceCatalogs(webVoices, extensionVoices, nativeVoices = []) {
    const merged = [...(webVoices || [])];
    const keys = new Set(merged.map(voiceKey));
    for (const rawVoice of extensionVoices || []) {
      const voice = rawVoice?.__edgeTtsSource === "chrome-tts"
        ? rawVoice
        : chromeVoiceToCatalogVoice(rawVoice);
      if (!voice) continue;
      const key = voiceKey(voice);
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(voice);
    }
    for (const rawVoice of nativeVoices || []) {
      const voice = rawVoice?.__edgeTtsSource === "win-natural"
        ? rawVoice
        : nativeVoiceToCatalogVoice(rawVoice);
      if (!voice) continue;
      const key = `win-natural:${voiceKey(voice)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(voice);
    }
    return merged;
  }

  function isChromeTtsVoice(voice) {
    return voice?.__edgeTtsSource === "chrome-tts";
  }

  function nativeVoiceToCatalogVoice(voice) {
    const nativeVoiceId = String(voice?.id || "").trim();
    const name = String(voice?.name || "").trim();
    if (!nativeVoiceId.toLowerCase().startsWith("local-") || !name) return null;
    return {
      name,
      lang: String(voice?.lang || ""),
      localService: false,
      remote: false,
      default: false,
      voiceURI: `win-natural:${nativeVoiceId}`,
      __edgeTtsSource: "win-natural",
      nativeVoiceId,
      catalogOnly: false
    };
  }

  function isWinNaturalVoice(voice) {
    return voice?.__edgeTtsSource === "win-natural";
  }

  function localRequestId(generation, chunkIndex) {
    return `${Date.now()}-${generation}-${chunkIndex}-${Math.random().toString(16).slice(2)}`;
  }

  function traceWinNatural(stage, details = {}) {
    try {
      root.console?.debug?.("Edge Natural TTS WIN-NATURAL", stage, details);
    } catch (_error) {}
  }

  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {
    return {
      LocalTtsSpeechEngine: null,
      chromeVoiceToCatalogVoice,
      isChromeTtsVoice,
      isWinNaturalVoice,
      nativeVoiceToCatalogVoice,
      mergeVoiceCatalogs,
      voiceKey
    };
  }

  class LocalTtsSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.extensionLocalVoices = [];
      this.winNaturalVoices = [];
      this.extensionVoiceListeners = new Set();
      this.extensionVoicesLoaded = false;
      this.winNaturalVoicesLoaded = false;
      this.extensionVoiceRequest = null;
      this.winNaturalVoiceRequest = null;
      this.localSessionMode = false;
      this.localActive = false;
      this.localRequest = null;
      this.winNaturalSessionMode = false;
      this.winNaturalActive = false;
      this.winNaturalRequest = null;
      this.winNaturalAudio = null;
      this.winNaturalObjectUrl = "";
      void this.refreshExtensionVoices();
      void this.refreshWinNaturalVoices();
    }

    getVoices() {
      return mergeVoiceCatalogs(
        super.getVoices?.() || [],
        this.extensionLocalVoices,
        this.winNaturalVoices
      );
    }

    async refreshExtensionVoices() {
      if (this.extensionVoiceRequest) return this.extensionVoiceRequest;
      if (!root.chrome?.runtime?.sendMessage) return this.extensionLocalVoices;

      this.extensionVoiceRequest = Promise.resolve(
        root.chrome.runtime.sendMessage({ type: "EDGE_TTS_LOCAL_VOICES" })
      )
        .then((response) => {
          this.extensionLocalVoices = (response?.voices || [])
            .map(chromeVoiceToCatalogVoice)
            .filter(Boolean);
          this.extensionVoicesLoaded = true;
          for (const listener of this.extensionVoiceListeners) {
            try {
              listener(this.getVoices());
            } catch (_error) {}
          }
          return this.extensionLocalVoices;
        })
        .catch((error) => {
          console.warn("Edge Natural TTS could not load Windows local voices.", error);
          return this.extensionLocalVoices;
        })
        .finally(() => {
          this.extensionVoiceRequest = null;
        });
      return this.extensionVoiceRequest;
    }

    async refreshWinNaturalVoices() {
      if (this.winNaturalVoiceRequest) return this.winNaturalVoiceRequest;
      if (!root.chrome?.runtime?.sendMessage) return this.winNaturalVoices;

      this.winNaturalVoiceRequest = Promise.resolve(
        root.chrome.runtime.sendMessage({ type: "EDGE_TTS_WIN_NATURAL_VOICES" })
      )
        .then((response) => {
          this.winNaturalVoices = (response?.voices || [])
            .map(nativeVoiceToCatalogVoice)
            .filter(Boolean);
          this.winNaturalVoicesLoaded = true;
          for (const listener of this.extensionVoiceListeners) {
            try {
              listener(this.getVoices());
            } catch (_error) {}
          }
          return this.winNaturalVoices;
        })
        .catch((error) => {
          console.warn("Edge Natural TTS could not load Windows Natural voices.", error);
          return this.winNaturalVoices;
        })
        .finally(() => {
          this.winNaturalVoiceRequest = null;
        });
      return this.winNaturalVoiceRequest;
    }

    onVoicesChanged(callback) {
      const unsubscribeBase = super.onVoicesChanged?.(callback) || (() => {});
      this.extensionVoiceListeners.add(callback);
      if (this.extensionVoicesLoaded || this.winNaturalVoicesLoaded) {
        root.queueMicrotask?.(() => callback(this.getVoices()));
      }
      return () => {
        unsubscribeBase();
        this.extensionVoiceListeners.delete(callback);
      };
    }

    _sendLocalStop(requestId = null) {
      if (!root.chrome?.runtime?.sendMessage) return;
      try {
        const pending = root.chrome.runtime.sendMessage({
          type: "EDGE_TTS_LOCAL_STOP",
          requestId
        });
        pending?.catch?.(() => {});
      } catch (_error) {}
    }

    _resetLocalState({ keepMode = true, stopTransport = true } = {}) {
      const requestId = this.localRequest?.requestId || null;
      if (stopTransport) this._sendLocalStop(requestId);
      this.clearPlaybackTimers?.();
      this.localRequest = null;
      this.localActive = false;
      this.currentUtterance = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = null;
      this.recoveryKey = "";
      this.recoveryAttempts = 0;
      if (!keepMode) this.localSessionMode = false;
    }

    _ensureWinNaturalAudio() {
      if (this.winNaturalAudio) return this.winNaturalAudio;
      const audio = root.document?.createElement?.("audio") ||
        (typeof root.Audio === "function" ? new root.Audio() : null);
      if (!audio) return null;
      audio.preload = "auto";
      this.winNaturalAudio = audio;
      return audio;
    }

    _revokeWinNaturalObjectUrl() {
      if (!this.winNaturalObjectUrl) return;
      try { root.URL?.revokeObjectURL?.(this.winNaturalObjectUrl); } catch (_error) {}
      this.winNaturalObjectUrl = "";
    }

    _resetWinNaturalState({ keepMode = true, reason = "reset" } = {}) {
      traceWinNatural("reset", {
        reason,
        requestId: this.winNaturalRequest?.requestId || null,
        active: this.winNaturalActive,
        objectUrl: Boolean(this.winNaturalObjectUrl)
      });
      const audio = this.winNaturalAudio;
      if (audio) {
        try {
          audio.pause?.();
          audio.removeAttribute?.("src");
          audio.load?.();
        } catch (_error) {}
      }
      this._revokeWinNaturalObjectUrl();
      this.winNaturalRequest = null;
      this.winNaturalActive = false;
      if (!keepMode) this.winNaturalSessionMode = false;
      this.clearPlaybackTimers?.();
      this.currentUtterance = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = null;
      this.recoveryKey = "";
      this.recoveryAttempts = 0;
    }

    ownsCompletionWithoutBoundaries() {
      return Boolean(this.winNaturalSessionMode && this.winNaturalRequest);
    }

    cancel() {
      if (this.winNaturalSessionMode) {
        this.generation += 1;
        this._resetWinNaturalState({ keepMode: true, reason: "cancel" });
        return;
      }
      if (this.localSessionMode) {
        this.generation += 1;
        this._resetLocalState({ keepMode: true, stopTransport: true });
        return;
      }
      return super.cancel?.();
    }

    abandon() {
      if (this.winNaturalSessionMode) {
        this.generation += 1;
        this._resetWinNaturalState({ keepMode: true, reason: "abandon" });
        return;
      }
      if (this.localSessionMode) {
        this.generation += 1;
        this._resetLocalState({ keepMode: true, stopTransport: true });
        return;
      }
      return super.abandon?.();
    }

    pause() {
      if (this.winNaturalSessionMode) {
        this.cancel();
        return;
      }
      return super.pause?.();
    }

    resume() {
      if (this.winNaturalSessionMode) return;
      return super.resume?.();
    }

    isPaused() {
      if (this.winNaturalSessionMode) return Boolean(this.winNaturalAudio?.paused && !this.winNaturalActive);
      if (this.localSessionMode) return false;
      return super.isPaused?.() || false;
    }

    isSpeaking() {
      if (this.winNaturalSessionMode) {
        return Boolean(this.winNaturalActive && this.winNaturalAudio && !this.winNaturalAudio.paused);
      }
      if (this.localSessionMode) return this.localActive;
      return super.isSpeaking?.() || false;
    }

    speak(block, startSegmentIndex, options = {}) {
      if (isWinNaturalVoice(options.voice)) {
        this._speakWinNatural(block, startSegmentIndex, options);
        return;
      }
      if (this.winNaturalSessionMode) {
        this.generation += 1;
        this._resetWinNaturalState({ keepMode: false, reason: "voice-switch" });
      }
      if (!isChromeTtsVoice(options.voice)) {
        if (this.localSessionMode) {
          this.generation += 1;
          this._resetLocalState({ keepMode: false, stopTransport: true });
        }
        return super.speak(block, startSegmentIndex, options);
      }

      const chunks = createUtteranceChunks(block, startSegmentIndex, options?.chunkOptions);
      if (!chunks.length) {
        this.onEnd?.();
        return;
      }

      if (this.localSessionMode) {
        this.cancel();
      } else {
        super.cancel?.();
      }

      this.localSessionMode = true;
      this.localActive = false;
      this.generation += 1;
      const generation = this.generation;
      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this._speakLocalChunk(generation);
    }

    prepareDirectPlayback(voice) {
      if (!isWinNaturalVoice(voice)) {
        return super.prepareDirectPlayback?.(voice) || false;
      }
      const audio = this._ensureWinNaturalAudio();
      if (!audio) return false;
      audio.muted = true;
      audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA";
      audio.load?.();
      const unlockPromise = audio.play?.();
      unlockPromise?.catch?.(() => {});
      audio.pause?.();
      audio.muted = false;
      audio.removeAttribute?.("src");
      audio.load?.();
      traceWinNatural("prepared", { hasAudio: true, srcCleared: true });
      return true;
    }

    _nativeBytesFromBase64(value) {
      const maxBytes = 8 * 1024 * 1024;
      if (typeof value !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Windows Natural returned invalid WAV data.");
      }
      const binary = root.atob(value);
      if (binary.length === 0 || binary.length > maxBytes) {
        throw new Error("Windows Natural returned an invalid WAV size.");
      }
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }

    _speakWinNatural(block, startSegmentIndex, options) {
      const chunks = createUtteranceChunks(block, startSegmentIndex, options?.chunkOptions);
      if (!chunks.length) {
        this.onEnd?.();
        return;
      }

      if (this.winNaturalSessionMode) {
        this.cancel();
      } else if (this.localSessionMode) {
        this.cancel();
      } else if (this.directSessionMode || typeof this.synth?.cancel === "function") {
        super.cancel?.();
      }

      this.winNaturalSessionMode = true;
      this.winNaturalActive = false;
      this.generation += 1;
      const generation = this.generation;
      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this._speakWinNaturalChunk(generation);
    }

    _speakWinNaturalChunk(generation) {
      if (generation !== this.generation || !this.winNaturalSessionMode) return;
      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (!payload) {
        this._resetWinNaturalState({ keepMode: true });
        this.onEnd?.();
        return;
      }

      const voiceId = this.currentOptions?.voice?.nativeVoiceId;
      const requestId = localRequestId(generation, this.currentChunkIndex);
      this.winNaturalRequest = { requestId, generation, chunkIndex: this.currentChunkIndex, payload };
      traceWinNatural("synthesis-request", {
        requestId,
        generation,
        voiceId,
        textLength: payload.text.length
      });
      Promise.resolve(root.chrome?.runtime?.sendMessage?.({
        type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE",
        requestId,
        voiceId,
        text: payload.text
      }))
        .then((response) => this._handleWinNaturalResponse(generation, requestId, response))
        .catch((error) => {
          if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) return;
          traceWinNatural("synthesis-error", { requestId, generation, message: error?.message || String(error) });
          this._resetWinNaturalState({ keepMode: true, reason: "synthesis-error" });
          this.onError?.(new Error(`Windows Natural synthesis failed: ${error?.message || String(error)}`));
        });
    }

    async _handleWinNaturalResponse(generation, requestId, response) {
      if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) {
        return;
      }
      traceWinNatural("synthesis-response-received", {
        requestId,
        generation,
        accepted: response?.accepted === true,
        base64Length: typeof response?.wavBase64 === "string" ? response.wavBase64.length : 0,
        totalBytes: response?.totalBytes ?? null
      });
      if (!response?.accepted) throw new Error(response?.error || "Windows Natural synthesis was refused.");
      if (response.totalBytes !== undefined && Number(response.totalBytes) < 1) {
        throw new Error("Windows Natural returned an invalid byte count.");
      }
      let bytes;
      try {
        bytes = this._nativeBytesFromBase64(response.wavBase64);
      } catch (error) {
        this._resetWinNaturalState({ keepMode: true, reason: "invalid-response" });
        this.onError?.(error);
        return;
      }
      if (response.totalBytes !== undefined && Number(response.totalBytes) !== bytes.length) {
        this._resetWinNaturalState({ keepMode: true, reason: "byte-count-mismatch" });
        this.onError?.(new Error("Windows Natural returned a WAV size mismatch."));
        return;
      }
      if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) return;
      traceWinNatural("synthesis-response", {
        requestId,
        generation,
        bytes: bytes.length,
        totalBytes: response.totalBytes ?? null
      });

      const audio = this._ensureWinNaturalAudio();
      if (!audio) {
        this._resetWinNaturalState({ keepMode: true, reason: "audio-unavailable" });
        this.onError?.(new Error("Windows Natural audio is unavailable."));
        return;
      }
      this._revokeWinNaturalObjectUrl();
      this.winNaturalObjectUrl = root.URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      audio.src = this.winNaturalObjectUrl;
      traceWinNatural("src-assigned", { requestId, generation, objectUrl: true });
      audio.onplay = () => traceWinNatural("event-play", { requestId, generation });
      audio.onplaying = () => traceWinNatural("event-playing", { requestId, generation });
      audio.onpause = () => traceWinNatural("event-pause", { requestId, generation });
      audio.onended = () => {
        if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) return;
        traceWinNatural("event-ended", { requestId, generation });
        this.winNaturalActive = false;
        this.winNaturalRequest = null;
        this._revokeWinNaturalObjectUrl();
        this.currentChunkIndex += 1;
        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.currentChunkIndex = -1;
          this.currentOptions = null;
          this.onEnd?.();
        } else {
          root.setTimeout(() => this._speakWinNaturalChunk(this.generation), 0);
        }
      };
      audio.onerror = () => {
        if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) return;
        traceWinNatural("event-error", { requestId, generation, mediaError: audio.error?.message || audio.error?.code || null });
        this.generation += 1;
        this._resetWinNaturalState({ keepMode: true, reason: "audio-error" });
        this.onError?.(new Error("Windows Natural audio playback failed."));
      };
      try {
        traceWinNatural("play-call", { requestId, generation, paused: audio.paused, srcPresent: Boolean(audio.src) });
        await audio.play();
        traceWinNatural("play-resolved", { requestId, generation, paused: audio.paused });
      } catch (error) {
        if (generation !== this.generation) return;
        traceWinNatural("play-rejected", { requestId, generation, name: error?.name || "", message: error?.message || String(error) });
        this._resetWinNaturalState({ keepMode: true, reason: "play-rejected" });
        this.onError?.(new Error(`Windows Natural audio playback failed: ${error?.message || String(error)}`));
        return;
      }
      if (generation !== this.generation || this.winNaturalRequest?.requestId !== requestId) return;
      this.winNaturalActive = true;
      const payload = this.winNaturalRequest.payload;
      const startedAt = root.performance?.now?.() ?? Date.now();
      this.onStart?.(payload.segments?.[0], Math.max(0, startedAt - this.requestedAt));
    }

    _speakLocalChunk(generation) {
      if (generation !== this.generation) return;
      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (!payload) {
        this.localActive = false;
        this.localRequest = null;
        this.currentChunks = [];
        this.currentChunkIndex = -1;
        this.currentOptions = null;
        this.onEnd?.();
        return;
      }

      const voice = this.currentOptions?.voice;
      const requestId = localRequestId(generation, this.currentChunkIndex);
      this.currentChunkBoundaryIndex = -1;
      this.localRequest = {
        requestId,
        generation,
        chunkIndex: this.currentChunkIndex,
        payload
      };

      const volume = Math.min(
        1,
        Math.max(0, Number(root.EdgeTtsExtension?.AudioControls?.currentVolume) || 0)
      );
      const message = {
        type: "EDGE_TTS_LOCAL_SPEAK",
        requestId,
        text: payload.text,
        voiceName: voice?.chromeVoiceName || voice?.name || "",
        lang: voice?.lang || "",
        rate: Math.min(10, Math.max(0.1, Number(this.currentOptions?.rate) || 1)),
        volume
      };

      Promise.resolve(root.chrome?.runtime?.sendMessage?.(message))
        .then((response) => {
          if (
            generation !== this.generation ||
            this.localRequest?.requestId !== requestId
          ) {
            return;
          }
          if (!response?.accepted) {
            this._failLocal("Windows local TTS backend refused the voice request.");
          }
        })
        .catch((error) => {
          if (generation !== this.generation) return;
          this._failLocal(error?.message || String(error));
        });
    }

    _failLocal(message) {
      this.localActive = false;
      this.localRequest = null;
      this.currentUtterance = null;
      this.onError?.(new Error(`Speech synthesis failed: ${message}`));
    }

    handleChromeTtsEvent(message) {
      const request = this.localRequest;
      if (
        !this.localSessionMode ||
        !request ||
        message?.requestId !== request.requestId ||
        request.generation !== this.generation
      ) {
        return false;
      }

      const event = message.event || {};
      const payload = request.payload;
      if (event.type === "start") {
        this.localActive = true;
        if (request.chunkIndex === 0) {
          const startedAt = root.performance?.now?.() ?? Date.now();
          this.onStart?.(payload.segments?.[0], Math.max(0, startedAt - this.requestedAt));
        }
        return true;
      }

      if (event.type === "word" || event.type === "sentence") {
        const charIndex = Math.max(0, Number(event.charIndex) || 0);
        const localIndex = typeof segmentIndexForCharIndex === "function"
          ? segmentIndexForCharIndex(payload.starts, charIndex)
          : 0;
        const segment = payload.segments?.[localIndex];
        if (segment) {
          this.currentChunkBoundaryIndex = localIndex;
          this.onBoundary?.(segment, {
            type: `chrome-tts-${event.type}`,
            charIndex,
            length: event.length,
            localTts: true
          });
        }
        return true;
      }

      if (event.type === "end") {
        this.localActive = false;
        this.localRequest = null;
        this.currentChunkBoundaryIndex = -1;
        this.currentChunkIndex += 1;
        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.currentChunkIndex = -1;
          this.currentOptions = null;
          this.onEnd?.();
        } else {
          root.setTimeout(() => this._speakLocalChunk(this.generation), 0);
        }
        return true;
      }

      if (["interrupted", "cancelled", "error"].includes(event.type)) {
        this.localActive = false;
        this.localRequest = null;
        const detail = event.errorMessage || event.type;
        this.onError?.(new Error(`Speech synthesis failed: ${detail}`));
        return true;
      }

      return false;
    }
  }

  return {
    LocalTtsSpeechEngine,
    chromeVoiceToCatalogVoice,
    isChromeTtsVoice,
    isWinNaturalVoice,
    nativeVoiceToCatalogVoice,
    mergeVoiceCatalogs,
    voiceKey
  };
});
