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

  function separatorForPiperSegments(left, right) {
    if (
      left?.blockIndex !== undefined &&
      right?.blockIndex !== undefined &&
      left.blockIndex !== right.blockIndex
    ) {
      return "\n\n";
    }
    return " ";
  }

  function payloadForPiperSegments(segments) {
    const starts = [];
    let text = "";
    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) {
        text += separatorForPiperSegments(segments[index - 1], segments[index]);
      }
      starts.push(text.length);
      text += String(segments[index]?.text || "");
    }
    return { text, starts, segments: [...segments] };
  }

  function createPiperSentenceChunks(block, startSegmentIndex = 0) {
    const remaining = Array.isArray(block?.segments)
      ? block.segments.slice(Math.max(0, Number(startSegmentIndex) || 0))
      : [];
    if (!remaining.length) return [];

    const chunks = [];
    let current = [];
    let currentKey = "";

    const flush = () => {
      if (!current.length) return;
      chunks.push(payloadForPiperSegments(current));
      current = [];
      currentKey = "";
    };

    for (const segment of remaining) {
      const key = `${segment?.blockIndex ?? "?"}:${segment?.sentenceIndex ?? 0}`;
      if (current.length && key !== currentKey) flush();
      if (!current.length) currentKey = key;
      current.push(segment);
    }

    flush();
    return chunks;
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

      this.linuxPiperRequests = new Map();
      this.linuxPiperPrepared = new Map();
      this.linuxPiperRequest = null;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperPausedInPlace = false;
      this.linuxPiperPrefetchDepth = 2;

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

    canPauseInPlace() {
      return Boolean(
        this.directSessionMode &&
        this.directAudio &&
        this.linuxPiperPlaybackIndex === this.currentChunkIndex
      );
    }

    pauseInPlace() {
      if (!this.canPauseInPlace() || this.directAudio?.paused) return false;
      try {
        this.directAudio.pause();
      } catch (_error) {
        return false;
      }
      this._clearBoundaryClock();
      this.directActive = false;
      this.linuxPiperPausedInPlace = true;
      return true;
    }

    resumeInPlace() {
      if (
        !this.linuxPiperPausedInPlace ||
        !this.directAudio ||
        this.linuxPiperPlaybackIndex !== this.currentChunkIndex
      ) {
        return false;
      }

      const generation = this.generation;
      this.linuxPiperPausedInPlace = false;
      this.directActive = true;
      void this.directAudio.play()
        .then(() => {
          if (generation !== this.generation) return;
          this._startBoundaryClock(generation);
          this.onStatus?.("Reading");
        })
        .catch((error) => this._failLinuxPiper(
          \`resume failed: \${error?.message || String(error)}\`
        ));
      return true;
    }

    speak(block, startSegmentIndex, options = {}) {
      if (!isLinuxPiperVoice(options.voice)) {
        return super.speak(block, startSegmentIndex, options);
      }

      const chunks = createPiperSentenceChunks(block, startSegmentIndex);
      if (!chunks.length) {
        this.onEnd?.();
        return;
      }

      this.cancel();
      this.directSessionMode = true;
      this.generation += 1;
      const generation = this.generation;

      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this.directPlaybackRate = Math.min(
        16,
        Math.max(0.25, Number(options.rate) || 1)
      );

      const configuredVolume = Number(root.EdgeTtsExtension?.AudioControls?.currentVolume);
      this.directOutputGain = Number.isFinite(configuredVolume)
        ? Math.min(2, Math.max(0, configuredVolume))
        : 1;

      this.linuxPiperPrepared.clear();
      this.linuxPiperRequests.clear();
      this.linuxPiperRequest = null;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperPausedInPlace = false;

      this._speakLinuxPiperChunk(generation);
    }

    _activeLinuxPiperRequestForChunk(chunkIndex) {
      for (const request of this.linuxPiperRequests.values()) {
        if (request.chunkIndex === chunkIndex) return request;
      }
      return null;
    }

    _startLinuxPiperSynthesis(generation, chunkIndex, prefetch = false) {
      if (
        generation !== this.generation ||
        !this.directSessionMode ||
        this.linuxPiperRequests.size > 0 ||
        this.linuxPiperPrepared.has(chunkIndex)
      ) {
        return false;
      }

      const payload = this.currentChunks?.[chunkIndex];
      if (!payload) return false;

      const request = requestId(generation, chunkIndex);
      const timeoutId = root.setTimeout(() => {
        const active = this.linuxPiperRequests.get(request);
        if (!active || generation !== this.generation) return;
        try {
          root.chrome?.runtime?.sendMessage?.({
            type: "EDGE_TTS_LINUX_PIPER_STOP",
            requestId: request
          });
        } catch (_error) {}
        this._handleLinuxPiperRequestFailure(
          active,
          "native synthesis timed out"
        );
      }, PIPER_SYNTHESIS_TIMEOUT_MS);

      const state = {
        requestId: request,
        generation,
        chunkIndex,
        payload,
        prefetch,
        audio: [],
        boundaries: [],
        timeoutId
      };
      this.linuxPiperRequests.set(request, state);
      if (!prefetch && chunkIndex === this.currentChunkIndex) {
        this.linuxPiperRequest = state;
        this.onStatus?.("Synthesizing with Piper...");
      }

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
          if (
            !response?.accepted &&
            generation === this.generation &&
            this.linuxPiperRequests.has(request)
          ) {
            this._handleLinuxPiperRequestFailure(
              state,
              "Linux Piper helper refused the request."
            );
          }
        })
        .catch((error) => {
          if (
            generation === this.generation &&
            this.linuxPiperRequests.has(request)
          ) {
            this._handleLinuxPiperRequestFailure(
              state,
              error?.message || String(error)
            );
          }
        });

      return true;
    }

    _handleLinuxPiperRequestFailure(request, message) {
      if (request?.timeoutId) root.clearTimeout(request.timeoutId);
      if (request?.requestId) this.linuxPiperRequests.delete(request.requestId);
      if (this.linuxPiperRequest === request) this.linuxPiperRequest = null;

      if (
        request?.generation === this.generation &&
        request?.chunkIndex === this.currentChunkIndex &&
        this.linuxPiperPlaybackIndex !== this.currentChunkIndex
      ) {
        this._failLinuxPiper(message);
      } else {
        root.setTimeout(() => this._fillLinuxPiperPrefetch(this.generation), 0);
      }
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

      const prepared = this.linuxPiperPrepared.get(this.currentChunkIndex);
      if (prepared) {
        this.linuxPiperPrepared.delete(this.currentChunkIndex);
        this._playLinuxPiperPrepared(generation, prepared);
        return;
      }

      if (this._activeLinuxPiperRequestForChunk(this.currentChunkIndex)) {
        this.onStatus?.("Synthesizing with Piper...");
        return;
      }

      this._startLinuxPiperSynthesis(
        generation,
        this.currentChunkIndex,
        false
      );
    }

    _fillLinuxPiperPrefetch(generation) {
      if (
        generation !== this.generation ||
        !this.directSessionMode ||
        !this.currentChunks?.length ||
        this.linuxPiperRequests.size > 0
      ) {
        return;
      }

      const lastIndex = Math.min(
        this.currentChunks.length - 1,
        this.currentChunkIndex + this.linuxPiperPrefetchDepth
      );

      for (
        let index = this.currentChunkIndex + 1;
        index <= lastIndex;
        index += 1
      ) {
        if (
          !this.linuxPiperPrepared.has(index) &&
          !this._activeLinuxPiperRequestForChunk(index)
        ) {
          this._startLinuxPiperSynthesis(generation, index, true);
          return;
        }
      }
    }

    _preparedLinuxPiperBoundaries(prepared) {
      const payload = prepared.payload;
      return prepared.boundaries.map((boundary) => {
        const charIndex = Math.max(0, Number(boundary.charIndex) || 0);
        const index = typeof segmentIndexForCharIndex === "function"
          ? segmentIndexForCharIndex(payload.starts, charIndex)
          : 0;
        return {
          segment: payload.segments?.[index],
          offsetSeconds:
            Math.max(0, Number(boundary.audioPositionMs) || 0) / 1000,
          durationSeconds:
            Math.max(0, Number(boundary.durationMs) || 0) / 1000,
          text: boundary.text || ""
        };
      });
    }

    _playLinuxPiperPrepared(generation, prepared) {
      if (
        generation !== this.generation ||
        prepared.chunkIndex !== this.currentChunkIndex
      ) {
        return;
      }

      const payload = prepared.payload;
      this.directActive = true;
      this.linuxPiperPlaybackIndex = prepared.chunkIndex;
      this.linuxPiperPausedInPlace = false;
      this.directBoundaries = this._preparedLinuxPiperBoundaries(prepared);
      this.directBoundaryIndex = 0;

      const blob = new Blob(prepared.audio, { type: "audio/wav" });
      this._revokeObjectUrl();
      this.directObjectUrl = root.URL.createObjectURL(blob);

      try {
        this.directAudio?.pause?.();
        this.directAudio?.removeAttribute?.("src");
        this.directAudio?.load?.();
      } catch (_error) {}

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

      const activeGeneration = prepared.generation;
      audio.onended = () => {
        if (activeGeneration !== this.generation) return;
        this._clearBoundaryClock();
        this.directActive = false;
        this.linuxPiperPausedInPlace = false;
        this.linuxPiperPlaybackIndex = -1;
        this.currentChunkIndex += 1;

        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.currentOptions = null;
          this.linuxPiperPrepared.clear();
          this.onEnd?.();
          return;
        }

        this._speakLinuxPiperChunk(activeGeneration);
      };

      audio.onerror = () => {
        if (activeGeneration !== this.generation) return;
        const mediaCode = audio.error?.code;
        this._failLinuxPiper(
          \`WAV playback failed\${mediaCode ? \` (media \${mediaCode})\` : ""}\`
        );
      };

      this.onStatus?.(
        prepared.prefetch ? "Playing prefetched Piper audio..." : "Playing Piper audio..."
      );

      void audio.play()
        .then(() => {
          if (activeGeneration !== this.generation) return;
          this.onStart?.(
            payload.segments?.[0],
            Math.max(
              0,
              (root.performance?.now?.() ?? Date.now()) - this.requestedAt
            )
          );
          this._startBoundaryClock(activeGeneration);
          this._fillLinuxPiperPrefetch(activeGeneration);
        })
        .catch((error) => {
          this._failLinuxPiper(
            \`audio.play() failed: \${error?.name || "Error"}: \${error?.message || String(error)}\`
          );
        });
    }

    _failLinuxPiper(message) {
      for (const request of this.linuxPiperRequests.values()) {
        if (request.timeoutId) root.clearTimeout(request.timeoutId);
      }
      this.linuxPiperRequests.clear();
      this.linuxPiperPrepared.clear();
      this.linuxPiperRequest = null;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperPausedInPlace = false;
      this._resetDirectState({ keepMode: true });
      this.onError?.(new Error(\`Linux Piper TTS failed: \${message}\`));
    }

    handleLinuxPiperEvent(message) {
      const request = this.linuxPiperRequests.get(
        String(message?.requestId || "")
      );
      if (
        !this.directSessionMode ||
        !request ||
        request.generation !== this.generation
      ) {
        return false;
      }

      const event = message.event || {};
      if (event.type === "status") {
        if (
          !request.prefetch &&
          request.chunkIndex === this.currentChunkIndex
        ) {
          this.onStatus?.(String(event.status || "Piper is working..."));
        }
        return true;
      }

      if (event.type === "boundary") {
        request.boundaries.push(event);
        return true;
      }

      if (event.type === "audioChunk") {
        request.audio.push(fromBase64(event.data));
        return true;
      }

      if (event.type === "error" || event.type === "cancelled") {
        this._handleLinuxPiperRequestFailure(
          request,
          event.message || event.errorMessage || event.type
        );
        return true;
      }

      if (event.type !== "synthesisEnd") return false;

      if (request.timeoutId) {
        root.clearTimeout(request.timeoutId);
        request.timeoutId = null;
      }

      this.linuxPiperRequests.delete(request.requestId);
      if (this.linuxPiperRequest === request) this.linuxPiperRequest = null;

      const prepared = {
        generation: request.generation,
        chunkIndex: request.chunkIndex,
        payload: request.payload,
        audio: request.audio,
        boundaries: request.boundaries,
        prefetch: request.prefetch
      };
      this.linuxPiperPrepared.set(request.chunkIndex, prepared);

      if (
        request.chunkIndex === this.currentChunkIndex &&
        this.linuxPiperPlaybackIndex !== this.currentChunkIndex
      ) {
        this._speakLinuxPiperChunk(request.generation);
      } else {
        this._fillLinuxPiperPrefetch(request.generation);
      }

      return true;
    }

    _stopLinuxPiperNativeWork() {
      const active = this.linuxPiperRequests.values().next().value;
      if (!active) return;
      try {
        root.chrome?.runtime?.sendMessage?.({
          type: "EDGE_TTS_LINUX_PIPER_STOP",
          requestId: active.requestId
        });
      } catch (_error) {}
    }

    cancel() {
      if (this.directSessionMode) {
        this._stopLinuxPiperNativeWork();
        for (const request of this.linuxPiperRequests.values()) {
          if (request.timeoutId) root.clearTimeout(request.timeoutId);
        }
        this.linuxPiperRequests.clear();
        this.linuxPiperPrepared.clear();
        this.linuxPiperRequest = null;
        this.linuxPiperPlaybackIndex = -1;
        this.linuxPiperPausedInPlace = false;
      }
      return super.cancel?.();
    }

    abandon() {
      if (this.directSessionMode) {
        this._stopLinuxPiperNativeWork();
        for (const request of this.linuxPiperRequests.values()) {
          if (request.timeoutId) root.clearTimeout(request.timeoutId);
        }
        this.linuxPiperRequests.clear();
        this.linuxPiperPrepared.clear();
        this.linuxPiperRequest = null;
        this.linuxPiperPlaybackIndex = -1;
        this.linuxPiperPausedInPlace = false;
      }
      return super.abandon?.();
    }
  }

  return {
    LinuxPiperSpeechEngine,
    isLinuxPiperVoice,
    mergeVoices,
    nativeVoiceToCatalogVoice,
    PIPER_SYNTHESIS_TIMEOUT_MS,
    createPiperSentenceChunks,
    payloadForPiperSegments
  };
});
