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
  const PIPER_SYNTHESIS_TIMEOUT_MS = 20_000;

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

      // Piper high-quality CPU models must not inherit the online backend's
      // large ~1200-character batching. Keep native requests short so first
      // audio arrives promptly and cancellation has frequent boundaries.
      const requestedChunks = options?.chunkOptions || {};
      const chunks = createUtteranceChunks(block, startSegmentIndex, {
        firstChunkMaxChars: Math.min(
          180,
          Math.max(80, Number(requestedChunks.firstChunkMaxChars) || 180)
        ),
        maxChars: Math.min(
          260,
          Math.max(120, Number(requestedChunks.maxChars) || 260)
        ),
        emergencyMaxChars: Math.min(
          500,
          Math.max(260, Number(requestedChunks.emergencyMaxChars) || 500)
        )
      });
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
      const timeoutId = root.setTimeout(() => {
        if (
          this.linuxPiperRequest?.requestId !== request ||
          generation !== this.generation
        ) {
          return;
        }
        try {
          root.chrome?.runtime?.sendMessage?.({
            type: "EDGE_TTS_LINUX_PIPER_STOP",
            requestId: request
          });
        } catch (_error) {}
        this._failLinuxPiper("native synthesis timed out");
      }, PIPER_SYNTHESIS_TIMEOUT_MS);

      this.linuxPiperRequest = {
        requestId: request,
        generation,
        payload,
        audio: [],
        boundaries: [],
        timeoutId
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
      if (this.linuxPiperRequest?.timeoutId) {
        root.clearTimeout(this.linuxPiperRequest.timeoutId);
      }
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

      if (request.timeoutId) {
        root.clearTimeout(request.timeoutId);
        request.timeoutId = null;
      }
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

      // Piper deliberately bypasses the shared Web Audio gain graph. Chromium
      // can leave an AudioContext suspended even while a media element appears
      // to advance, producing silent playback. A fresh unrouted media element
      // is the smallest reliable Linux path; Piper volume is therefore capped
      // at 100% until the native backend is proven stable.
      try {
        this.directAudio?.pause?.();
        this.directAudio?.removeAttribute?.("src");
        this.directAudio?.load?.();
      } catch (_error) {}
      try {
        this.directMediaSource?.disconnect?.();
      } catch (_error) {}
      try {
        this.directGain?.disconnect?.();
      } catch (_error) {}
      try {
        this.directAudioContext?.close?.();
      } catch (_error) {}
      this.directMediaSource = null;
      this.directGain = null;
      this.directAudioContext = null;

      const audio = root.document?.createElement?.("audio") || new root.Audio();
      audio.preload = "auto";
      audio.preservesPitch = true;
      if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
      audio.src = this.directObjectUrl;
      audio.playbackRate = this.directPlaybackRate;
      audio.volume = Math.min(
        1,
        Math.max(0, Number(this.directOutputGain) || 0)
      );
      this.directAudio = audio;

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
          const mediaCode = audio.error?.code;
          this._failLinuxPiper(
            `WAV playback failed${mediaCode ? ` (media ${mediaCode})` : ""}`
          );
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
        .catch((error) => {
          this._failLinuxPiper(
            `audio.play() failed: ${error?.name || "Error"}: ${error?.message || String(error)}`
          );
        });

      return true;
    }

    cancel() {
      if (this.directSessionMode && this.linuxPiperRequest) {
        if (this.linuxPiperRequest.timeoutId) {
          root.clearTimeout(this.linuxPiperRequest.timeoutId);
        }
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
    nativeVoiceToCatalogVoice,
    PIPER_SYNTHESIS_TIMEOUT_MS
  };
});
