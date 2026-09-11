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

  function mergeVoiceCatalogs(webVoices, extensionVoices) {
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
    return merged;
  }

  function isChromeTtsVoice(voice) {
    return voice?.__edgeTtsSource === "chrome-tts";
  }

  function localRequestId(generation, chunkIndex) {
    return `${Date.now()}-${generation}-${chunkIndex}-${Math.random().toString(16).slice(2)}`;
  }

  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {
    return {
      LocalTtsSpeechEngine: null,
      chromeVoiceToCatalogVoice,
      isChromeTtsVoice,
      mergeVoiceCatalogs,
      voiceKey
    };
  }

  class LocalTtsSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.extensionLocalVoices = [];
      this.extensionVoiceListeners = new Set();
      this.extensionVoicesLoaded = false;
      this.extensionVoiceRequest = null;
      this.localSessionMode = false;
      this.localActive = false;
      this.localRequest = null;
      void this.refreshExtensionVoices();
    }

    getVoices() {
      return mergeVoiceCatalogs(super.getVoices?.() || [], this.extensionLocalVoices);
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

    onVoicesChanged(callback) {
      const unsubscribeBase = super.onVoicesChanged?.(callback) || (() => {});
      this.extensionVoiceListeners.add(callback);
      if (this.extensionVoicesLoaded) {
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

    cancel() {
      if (this.localSessionMode) {
        this.generation += 1;
        this._resetLocalState({ keepMode: true, stopTransport: true });
        return;
      }
      return super.cancel?.();
    }

    abandon() {
      if (this.localSessionMode) {
        this.generation += 1;
        this._resetLocalState({ keepMode: true, stopTransport: true });
        return;
      }
      return super.abandon?.();
    }

    isPaused() {
      if (this.localSessionMode) return false;
      return super.isPaused?.() || false;
    }

    isSpeaking() {
      if (this.localSessionMode) return this.localActive;
      return super.isSpeaking?.() || false;
    }

    setPlaybackRate() {
      return false;
    }

    setOutputVolume() {
      return false;
    }

    speak(block, startSegmentIndex, options = {}) {
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
    mergeVoiceCatalogs,
    voiceKey
  };
});
