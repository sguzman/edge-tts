(function attachLinuxPiperEngine(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root.EdgeTtsExtension?.SpeechEngine && api.LinuxPiperSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.LinuxPiperSpeechEngine;
    root.EdgeTtsExtension.LinuxPiper = api;
  }
})(globalThis, function createLinuxPiperEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;
  const createUtteranceChunks = speechModule?.createUtteranceChunks;
  const segmentIndexForCharIndex = root.EdgeTtsExtension?.TextModel?.segmentIndexForCharIndex;

  function voiceKey(voice) {
    return `${String(voice?.name || "").toLocaleLowerCase()}\u0000${String(voice?.lang || "").toLocaleLowerCase()}`;
  }

  function isLinuxPiperVoice(voice) {
    return voice?.__edgeTtsSource === "linux-piper";
  }

  function nativeVoiceToCatalogVoice(raw) {
    const name = String(raw?.name || "").trim();
    const voiceId = String(raw?.id || "").trim();
    if (!name || !voiceId) return null;
    return {
      name,
      lang: String(raw?.lang || ""),
      localService: true,
      default: false,
      voiceURI: `linux-piper:${voiceId}`,
      __edgeTtsSource: "linux-piper",
      voiceId,
      quality: String(raw?.quality || ""),
      eventTypes: ["start", "word", "sentence", "end"]
    };
  }

  function mergeVoices(base, native) {
    const result = [...(base || [])];
    for (const raw of native || []) {
      const voice = raw?.__edgeTtsSource === "linux-piper" ? raw : nativeVoiceToCatalogVoice(raw);
      if (!voice) continue;
      const key = voiceKey(voice);
      const existingIndex = result.findIndex((candidate) => voiceKey(candidate) === key);
      if (existingIndex < 0) result.push(voice);
      else if (result[existingIndex]?.__edgeTtsSource !== "linux-piper") result[existingIndex] = voice;
    }
    return result;
  }

  function requestId(generation, chunkIndex) {
    return `${Date.now()}-${generation}-${chunkIndex}-${Math.random().toString(16).slice(2)}`;
  }

  function fromBase64(value) {
    const binary = root.atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {
    return {
      LinuxPiperSpeechEngine: null,
      isLinuxPiperVoice,
      mergeVoices,
      nativeVoiceToCatalogVoice
    };
  }

  class LinuxPiperSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.linuxPiperVoices = [];
      this.linuxPiperVoiceListeners = new Set();
      this.linuxPiperVoicesLoaded = false;
      this.linuxPiperVoiceRequest = null;
      this.linuxPiperRequest = null;
      void this.refreshLinuxPiperVoices();
    }

    getVoices() {
      return mergeVoices(super.getVoices?.() || [], this.linuxPiperVoices);
    }

    onVoicesChanged(callback) {
      const unsubscribe = super.onVoicesChanged?.(callback) || (() => {});
      this.linuxPiperVoiceListeners.add(callback);
      if (this.linuxPiperVoicesLoaded) {
        root.queueMicrotask?.(() => callback(this.getVoices()));
      }
      return () => {
        unsubscribe();
        this.linuxPiperVoiceListeners.delete(callback);
      };
    }

    async refreshLinuxPiperVoices() {
      if (this.linuxPiperVoiceRequest) return this.linuxPiperVoiceRequest;
      if (!root.chrome?.runtime?.sendMessage) return this.linuxPiperVoices;

      this.linuxPiperVoiceRequest = Promise.resolve(
        root.chrome.runtime.sendMessage({ type: "EDGE_TTS_LINUX_PIPER_VOICES" })
      )
        .then((response) => {
          this.linuxPiperVoices = (response?.voices || [])
            .map(nativeVoiceToCatalogVoice)
            .filter(Boolean);
          this.linuxPiperVoicesLoaded = true;
          for (const listener of this.linuxPiperVoiceListeners) {
            try { listener(this.getVoices()); } catch (_error) {}
          }
          return this.linuxPiperVoices;
        })
        .catch(() => this.linuxPiperVoices)
        .finally(() => {
          this.linuxPiperVoiceRequest = null;
        });

      return this.linuxPiperVoiceRequest;
    }

    canPlayIndependently(voice) {
      return isLinuxPiperVoice(voice) || super.canPlayIndependently?.(voice);
    }

    speak(block, startSegmentIndex, options = {}) {
      if (!isLinuxPiperVoice(options.voice)) {
        return super.speak(block, startSegmentIndex, options);
      }

      const chunks = createUtteranceChunks(block, startSegmentIndex, options?.chunkOptions);
      if (!chunks.length) {
        this.onEnd?.();
        return;
      }

      this.cancel();
      this.directSessionMode = true;
      this.directActive = true;
      this.generation += 1;
      const generation = this.generation;
      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this.directPlaybackRate = Math.min(16, Math.max(0.25, Number(options.rate) || 1));

      const configuredVolume = Number(root.EdgeTtsExtension?.AudioControls?.currentVolume);
      this.directOutputGain = Number.isFinite(configuredVolume)
        ? Math.min(2, Math.max(0, configuredVolume))
        : 1;

      this._speakLinuxPiperChunk(generation);
    }

    _speakLinuxPiperChunk(generation) {
      if (generation !== this.generation) return;
      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (!payload) {
        this.directActive = false;
        this.directSessionMode = true;
        this.onEnd?.();
        return;
      }

      const request = requestId(generation, this.currentChunkIndex);
      this.linuxPiperRequest = {
        requestId: request,
        generation,
        payload,
        audio: [],
        boundaries: []
      };

      Promise.resolve(
        root.chrome?.runtime?.sendMessage?.({
          type: "EDGE_TTS_LINUX_PIPER_SYNTHESIZE",
          requestId: request,
          text: payload.text,
          voiceId: this.currentOptions?.voice?.voiceId,
          lang: this.currentOptions?.voice?.lang
        })
      )
        .then((response) => {
          if (!response?.accepted && generation === this.generation) {
            this._failLinuxPiper("Linux Piper helper refused the request.");
          }
        })
        .catch((error) => {
          if (generation === this.generation) {
            this._failLinuxPiper(error?.message || String(error));
          }
        });
    }

    _failLinuxPiper(message) {
      this._resetDirectState({ keepMode: true });
      this.linuxPiperRequest = null;
      this.onError?.(new Error(`Linux Piper TTS failed: ${message}`));
    }

    handleLinuxPiperEvent(message) {
      const request = this.linuxPiperRequest;
      if (
        !this.directSessionMode ||
        !request ||
        message?.requestId !== request.requestId ||
        request.generation !== this.generation
      ) {
        return false;
      }

      const event = message.event || {};
      if (event.type === "boundary") {
        request.boundaries.push(event);
        return true;
      }
      if (event.type === "audioChunk") {
        request.audio.push(fromBase64(event.data));
        return true;
      }
      if (event.type === "error" || event.type === "cancelled") {
        this._failLinuxPiper(event.message || event.errorMessage || event.type);
        return true;
      }
      if (event.type !== "synthesisEnd") return false;

      const payload = request.payload;
      this.directBoundaries = request.boundaries.map((boundary) => {
        const charIndex = Math.max(0, Number(boundary.charIndex) || 0);
        const index = typeof segmentIndexForCharIndex === "function"
          ? segmentIndexForCharIndex(payload.starts, charIndex)
          : 0;
        return {
          segment: payload.segments?.[index],
          offsetSeconds: Math.max(0, Number(boundary.audioPositionMs) || 0) / 1000,
          durationSeconds: Math.max(0, Number(boundary.durationMs) || 0) / 1000,
          text: boundary.text || ""
        };
      });
      this.directBoundaryIndex = 0;

      const blob = new Blob(request.audio, { type: "audio/wav" });
      this._revokeObjectUrl();
      this.directObjectUrl = root.URL.createObjectURL(blob);
      const audio = this._ensureAudioElement();
      audio.src = this.directObjectUrl;
      audio.playbackRate = this.directPlaybackRate;
      this._applyDirectGain();

      const activeGeneration = request.generation;
      audio.onended = () => {
        if (activeGeneration !== this.generation) return;
        this._clearBoundaryClock();
        this.directActive = false;
        this.linuxPiperRequest = null;
        this.currentChunkIndex += 1;
        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.currentOptions = null;
          this.onEnd?.();
        } else {
          root.setTimeout(() => this._speakLinuxPiperChunk(activeGeneration), 0);
        }
      };
      audio.onerror = () => {
        if (activeGeneration === this.generation) {
          this._failLinuxPiper("WAV playback failed");
        }
      };

      void audio.play()
        .then(() => {
          if (activeGeneration !== this.generation) return;
          this.onStart?.(
            payload.segments?.[0],
            Math.max(0, (root.performance?.now?.() ?? Date.now()) - this.requestedAt)
          );
          this._startBoundaryClock(activeGeneration);
        })
        .catch((error) => this._failLinuxPiper(error?.message || String(error)));

      return true;
    }

    cancel() {
      if (this.directSessionMode && this.linuxPiperRequest) {
        try {
          root.chrome?.runtime?.sendMessage?.({
            type: "EDGE_TTS_LINUX_PIPER_STOP",
            requestId: this.linuxPiperRequest.requestId
          });
        } catch (_error) {}
        this.linuxPiperRequest = null;
      }
      return super.cancel?.();
    }

    abandon() {
      return this.cancel();
    }
  }

  return {
    LinuxPiperSpeechEngine,
    isLinuxPiperVoice,
    mergeVoices,
    nativeVoiceToCatalogVoice
  };
});
