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
  const pronunciation = root.EdgeTtsExtension?.Pronunciation;
  const PIPER_SYNTHESIS_TIMEOUT_MS = 20_000;
  const PIPER_SOFT_CLAUSE_CHARS = 240;
  const PIPER_HARD_CLAUSE_CHARS = 320;
  const PIPER_SOFT_CLAUSE_WORDS = 38;
  const PIPER_HARD_CLAUSE_WORDS = 52;

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

  function punctuationPauseWeight(token) {
    const text = String(token || "");
    if (/[.!?]["'”’\)\]]*$/.test(text)) return 5;
    if (/[;:]["'”’\)\]]*$/.test(text)) return 3.5;
    if (/[,]["'”’\)\]]*$/.test(text)) return 2.25;
    if (/[—–-]["'”’\)\]]*$/.test(text)) return 1.25;
    return 0;
  }

  function approximatePiperBoundaries(payload, durationMs) {
    const text = String(payload?.text || "");
    const duration = Math.max(0, Number(durationMs) || 0);
    if (!text || duration <= 0) return [];

    const matches = [...text.matchAll(/\S+/g)];
    if (!matches.length) return [];

    const weights = matches.map((match) => {
      const lexical = String(match[0] || "").replace(/[^\p{L}\p{N}]+/gu, "");
      const lexicalWeight = Math.max(
        1,
        Math.pow([...lexical].length || 1, 0.9)
      );
      return lexicalWeight + punctuationPauseWeight(match[0]);
    });
    const total = Math.max(
      1,
      weights.reduce((sum, weight) => sum + weight, 0)
    );

    let cursorMs = 0;
    return matches.map((match, index) => {
      const spanMs = duration * (weights[index] / total);
      const charIndex = Number(match.index) || 0;
      const segmentIndex =
        typeof segmentIndexForCharIndex === "function"
          ? segmentIndexForCharIndex(payload.starts || [], charIndex)
          : 0;

      const boundary = {
        segment: payload.segments?.[Math.max(0, segmentIndex)],
        offsetSeconds: cursorMs / 1000,
        durationSeconds: spanMs / 1000,
        text: match[0]
      };
      cursorMs += spanMs;
      return boundary;
    });
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
    if (typeof pronunciation?.projectSegments === "function") {
      return pronunciation.projectSegments(
        segments,
        separatorForPiperSegments
      );
    }

    const starts = [];
    let text = "";
    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) {
        text += separatorForPiperSegments(segments[index - 1], segments[index]);
      }
      starts.push(text.length);
      text += String(segments[index]?.text || "");
    }
    return { text, starts, segments: [...segments], transformations: [] };
  }

  function isPiperClauseBreak(segment) {
    const text = String(segment?.text || "");
    return /[,;:][\"'”’\)\]]*$/.test(text) ||
      /[—–-][\"'”’\)\]]*$/.test(text);
  }

  function piperPayloadWithinHardLimit(payload) {
    const wordCount = payload?.segments?.length || 0;
    const charCount = String(payload?.text || "").length;
    return (
      charCount <= PIPER_HARD_CLAUSE_CHARS &&
      wordCount <= PIPER_HARD_CLAUSE_WORDS
    );
  }

  function piperPayloadWithinSoftLimit(payload) {
    const wordCount = payload?.segments?.length || 0;
    const charCount = String(payload?.text || "").length;
    return (
      charCount <= PIPER_SOFT_CLAUSE_CHARS &&
      wordCount <= PIPER_SOFT_CLAUSE_WORDS
    );
  }

  function splitPiperSentenceSegments(segments) {
    if (!segments?.length) return [];

    const whole = payloadForPiperSegments(segments);
    if (piperPayloadWithinSoftLimit(whole)) {
      whole.sentenceFinal = true;
      whole.emergencyClauseSplit = false;
      return [whole];
    }

    const units = [];
    let cursor = 0;

    while (cursor < segments.length) {
      let bestSoftBreak = -1;
      let lastHardFit = cursor;
      let probe = cursor;

      for (; probe < segments.length; probe += 1) {
        const candidate = payloadForPiperSegments(
          segments.slice(cursor, probe + 1)
        );

        if (!piperPayloadWithinHardLimit(candidate)) {
          break;
        }

        lastHardFit = probe;
        if (
          piperPayloadWithinSoftLimit(candidate) &&
          isPiperClauseBreak(segments[probe])
        ) {
          bestSoftBreak = probe;
        }

        const candidateWords = candidate?.segments?.length || 0;
        const candidateChars = String(candidate?.text || "").length;
        const crossedUsefulSize =
          candidateChars >= Math.floor(PIPER_SOFT_CLAUSE_CHARS * 0.55) ||
          candidateWords >= Math.floor(PIPER_SOFT_CLAUSE_WORDS * 0.55);

        if (
          crossedUsefulSize &&
          isPiperClauseBreak(segments[probe]) &&
          (
            candidateChars >= PIPER_SOFT_CLAUSE_CHARS ||
            candidateWords >= PIPER_SOFT_CLAUSE_WORDS
          )
        ) {
          bestSoftBreak = probe;
          probe += 1;
          break;
        }
      }

      let endIndex;
      if (bestSoftBreak >= cursor) {
        endIndex = bestSoftBreak;
      } else if (probe >= segments.length) {
        endIndex = segments.length - 1;
      } else {
        // Prefer the most recent clause boundary that still fits under the hard
        // ceiling, even when it lands beyond the soft target.
        let clauseBreak = -1;
        for (let index = lastHardFit; index >= cursor; index -= 1) {
          if (isPiperClauseBreak(segments[index])) {
            clauseBreak = index;
            break;
          }
        }
        endIndex = clauseBreak >= cursor ? clauseBreak : lastHardFit;
      }

      if (endIndex < cursor) endIndex = cursor;

      const payload = payloadForPiperSegments(
        segments.slice(cursor, endIndex + 1)
      );
      payload.sentenceFinal = endIndex === segments.length - 1;
      payload.emergencyClauseSplit = true;
      units.push(payload);
      cursor = endIndex + 1;
    }

    return units;
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
      const sentenceChunks = splitPiperSentenceSegments(current);
      for (const payload of sentenceChunks) {
        if (payload?.text?.trim()) {
          chunks.push(payload);
        }
      }
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
      this.linuxPiperPronunciationRequest = null;
      this.linuxPiperSpeakSerial = 0;

      this.linuxPiperRequests = new Map();
      this.linuxPiperPrepared = new Map();
      this.linuxPiperRequest = null;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperPausedInPlace = false;
      this.linuxPiperOffscreenPlayback = null;
      this.linuxPiperSentencePauseTimer = null;
      this.linuxPiperPrefetchDepth = 2;

      void this.refreshLinuxPiperVoices();
      void this.refreshPronunciationConfig();
    }

    refreshPronunciationConfig() {
      if (this.linuxPiperPronunciationRequest) {
        return this.linuxPiperPronunciationRequest;
      }
      if (typeof pronunciation?.loadConfig !== "function") {
        return Promise.resolve(null);
      }

      this.linuxPiperPronunciationRequest = Promise.resolve(
        pronunciation.loadConfig()
      ).finally(() => {
        this.linuxPiperPronunciationRequest = null;
      });
      return this.linuxPiperPronunciationRequest;
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


    _hasLinuxPiperOffscreenPlayback() {
      return Boolean(
        this.linuxPiperOffscreenPlayback &&
        this.linuxPiperOffscreenPlayback.chunkIndex === this.currentChunkIndex
      );
    }

    canPauseInPlace() {
      if (
        this.directSessionMode &&
        this._hasLinuxPiperOffscreenPlayback()
      ) {
        return true;
      }
      return Boolean(
        this.directSessionMode &&
        this.directAudio &&
        this.linuxPiperPlaybackIndex === this.currentChunkIndex
      );
    }

    isSpeaking() {
      if (this.directSessionMode && this._hasLinuxPiperOffscreenPlayback()) {
        return Boolean(
          this.directActive &&
          !this.linuxPiperOffscreenPlayback.paused
        );
      }
      return super.isSpeaking?.() || false;
    }

    isPaused() {
      if (this.directSessionMode && this._hasLinuxPiperOffscreenPlayback()) {
        return Boolean(this.linuxPiperOffscreenPlayback.paused);
      }
      return super.isPaused?.() || false;
    }

    setPlaybackRate(rate) {
      if (this.directSessionMode && this._hasLinuxPiperOffscreenPlayback()) {
        this.directPlaybackRate = Math.min(
          16,
          Math.max(0.25, Number(rate) || 1)
        );
        void root.chrome?.runtime?.sendMessage?.({
          type: "EDGE_TTS_PIPER_OFFSCREEN_RATE",
          playbackId: this.linuxPiperOffscreenPlayback.playbackId,
          playbackRate: this.directPlaybackRate
        }).catch?.(() => {});
        return true;
      }
      return super.setPlaybackRate?.(rate) ?? false;
    }

    setSentencePauseMs(ms) {
      const value = Math.max(0, Math.min(1200, Number(ms) || 0));
      if (this.currentOptions) {
        this.currentOptions.sentencePauseMs = value;
      }
      return value;
    }

    setOutputVolume(volume) {
      if (this.directSessionMode && this._hasLinuxPiperOffscreenPlayback()) {
        this.directOutputGain = Math.min(
          2,
          Math.max(0, Number(volume) || 0)
        );
        void root.chrome?.runtime?.sendMessage?.({
          type: "EDGE_TTS_PIPER_OFFSCREEN_VOLUME",
          playbackId: this.linuxPiperOffscreenPlayback.playbackId,
          volume: Math.min(1, this.directOutputGain)
        }).catch?.(() => {});
        return true;
      }
      return super.setOutputVolume?.(volume) ?? false;
    }

    _clearLinuxPiperSentencePause() {
      if (this.linuxPiperSentencePauseTimer !== null) {
        root.clearTimeout(this.linuxPiperSentencePauseTimer);
        this.linuxPiperSentencePauseTimer = null;
      }
    }

    pauseInPlace() {
      if (!this.canPauseInPlace()) return false;

      if (this._hasLinuxPiperOffscreenPlayback()) {
        const playback = this.linuxPiperOffscreenPlayback;
        const playbackId = playback.playbackId;
        const generation = playback.generation;
        this.onStatus?.("Pausing...");

        const pauseCommand = Promise.resolve(
          root.chrome?.runtime?.sendMessage?.({
            type: "EDGE_TTS_PIPER_OFFSCREEN_PAUSE",
            playbackId
          })
        );
        const pauseTimeout = new Promise((resolve) => {
          root.setTimeout(() => {
            resolve({
              accepted: false,
              error: "Offscreen Piper pause acknowledgement timed out."
            });
          }, 900);
        });

        return Promise.race([pauseCommand, pauseTimeout])
          .then((response) => {
            if (
              this.linuxPiperOffscreenPlayback?.playbackId !== playbackId ||
              generation !== this.generation
            ) {
              return false;
            }
            if (!response?.accepted) {
              return false;
            }

            playback.paused = true;
            this._clearBoundaryClock();
            this.directActive = false;
            this.linuxPiperPausedInPlace = true;
            return true;
          })
          .catch(() => false);
      }

      if (this.directAudio?.paused) return false;
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
        this.linuxPiperPlaybackIndex !== this.currentChunkIndex
      ) {
        return false;
      }

      if (this._hasLinuxPiperOffscreenPlayback()) {
        const playback = this.linuxPiperOffscreenPlayback;
        const playbackId = playback.playbackId;
        playback.resumePending = true;
        this.onStatus?.("Resuming...");

        const resumeCommand = Promise.resolve(
          root.chrome?.runtime?.sendMessage?.({
            type: "EDGE_TTS_PIPER_OFFSCREEN_RESUME",
            playbackId
          })
        );
        const resumeTimeout = new Promise((resolve) => {
          root.setTimeout(() => {
            resolve({
              accepted: false,
              error: "Offscreen Piper resume acknowledgement timed out."
            });
          }, 1500);
        });

        return Promise.race([resumeCommand, resumeTimeout])
          .then((response) => {
            if (
              this.linuxPiperOffscreenPlayback?.playbackId !== playbackId ||
              playback.generation !== this.generation
            ) {
              return false;
            }

            playback.resumePending = false;
            if (!response?.accepted) {
              // The offscreen AUDIO_PLAYBACK document may have been discarded
              // while paused. Keep our canonical cursor/prepared WAV state,
              // retire the stale session, and let ReaderApp restart from the
              // current highlighted word instead of claiming playback resumed.
              playback.paused = true;
              this.directActive = false;
              this.linuxPiperPausedInPlace = true;
              this.linuxPiperOffscreenPlayback = null;
              this.onStatus?.("Resume session expired — restarting...");
              return false;
            }

            // audio.play() has actually resolved in the offscreen document.
            // The resumed event normally reaches us as well, but make local
            // state truthful from the confirmed command response.
            playback.paused = false;
            this.directActive = true;
            this.linuxPiperPausedInPlace = false;
            this.onStatus?.("Reading");
            return true;
          })
          .catch((error) => {
            if (
              this.linuxPiperOffscreenPlayback?.playbackId === playbackId
            ) {
              playback.resumePending = false;
              playback.paused = true;
              this.directActive = false;
              this.linuxPiperPausedInPlace = true;
              this.linuxPiperOffscreenPlayback = null;
            }
            console.warn(
              "Edge Natural TTS offscreen resume transport failed.",
              error
            );
            this.onStatus?.("Resume transport failed — restarting...");
            return false;
          });
      }

      if (!this.directAudio) return false;

      const generation = this.generation;
      return Promise.resolve(this.directAudio.play())
        .then(() => {
          if (generation !== this.generation) return false;
          this.linuxPiperPausedInPlace = false;
          this.directActive = true;
          this._startLinuxPiperBoundaryClock(generation);
          this.onStatus?.("Reading");
          return true;
        })
        .catch((error) => {
          console.warn("Edge Natural TTS direct resume failed.", error);
          return false;
        });
    }

    speak(block, startSegmentIndex, options = {}) {
      if (!isLinuxPiperVoice(options.voice)) {
        this.linuxPiperSpeakSerial += 1;
        return super.speak(block, startSegmentIndex, options);
      }

      // Retire the previous session immediately, then force-read the persisted
      // pronunciation config before building any Piper payload. This makes an
      // explicit Options save authoritative even if a storage change event was
      // delayed or missed in the content-script world.
      this.cancel();
      const speakSerial = ++this.linuxPiperSpeakSerial;
      this.onStatus?.("Loading pronunciation rules...");

      Promise.resolve(
        pronunciation?.loadConfig?.({ force: true })
      )
        .catch((error) => {
          console.warn(
            "Edge Natural TTS could not refresh pronunciation rules before speech.",
            error
          );
          return pronunciation?.getConfig?.() || null;
        })
        .then(() => {
          if (speakSerial !== this.linuxPiperSpeakSerial) return;
          this._beginLinuxPiperSpeak(
            block,
            startSegmentIndex,
            options,
            speakSerial
          );
        });
    }

    _beginLinuxPiperSpeak(block, startSegmentIndex, options, speakSerial) {
      if (speakSerial !== this.linuxPiperSpeakSerial) return;

      const chunks = createPiperSentenceChunks(block, startSegmentIndex);
      if (!chunks.length) {
        this.onEnd?.();
        return;
      }

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

      const configuredVolume = Number(
        root.EdgeTtsExtension?.AudioControls?.currentVolume
      );
      this.directOutputGain = Number.isFinite(configuredVolume)
        ? Math.min(2, Math.max(0, configuredVolume))
        : 1;

      this._clearLinuxPiperSentencePause();
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
        audioBase64: [],
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
          lang: this.currentOptions?.voice?.lang,
          pronunciationRevision: Number(payload.configRevision) || 0,
          pronunciationSavedAt: Number(payload.configSavedAt) || 0
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
              response?.error
                ? `Linux Piper helper refused the request: ${response.error}`
                : "Linux Piper helper refused the request."
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
      if (prepared?.boundariesArePrepared) {
        return [...(prepared.boundaries || [])];
      }

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

    _startLinuxPiperBoundaryClock(generation) {
      this._clearBoundaryClock();
      const tick = () => {
        if (
          generation !== this.generation ||
          !this.directActive
        ) {
          this.directBoundaryFrame = null;
          return;
        }

        const mediaTime = this._hasLinuxPiperOffscreenPlayback()
          ? Math.max(
              0,
              Number(this.linuxPiperOffscreenPlayback?.currentTime) || 0
            )
          : Math.max(0, Number(this.directAudio?.currentTime) || 0);

        while (
          this.directBoundaryIndex < this.directBoundaries.length &&
          this.directBoundaries[this.directBoundaryIndex].offsetSeconds <=
            mediaTime + 0.025
        ) {
          const boundary = this.directBoundaries[this.directBoundaryIndex];
          this.directBoundaryIndex += 1;
          if (boundary.segment) {
            this.currentChunkBoundaryIndex = this.directBoundaryIndex - 1;
            this.onBoundary?.(boundary.segment, {
              type: "linux-piper-boundary",
              directAudio: true,
              audioOffset: boundary.offsetSeconds,
              duration: boundary.durationSeconds,
              spokenText: boundary.text
            });
          }
        }

        this.directBoundaryFrame =
          root.requestAnimationFrame?.(tick) ?? null;
      };

      this.directBoundaryFrame =
        root.requestAnimationFrame?.(tick) ?? null;
    }

    _stopLinuxPiperOffscreenPlayback() {
      const playback = this.linuxPiperOffscreenPlayback;
      if (!playback) return false;

      this.linuxPiperOffscreenPlayback = null;
      try {
        void root.chrome?.runtime?.sendMessage?.({
          type: "EDGE_TTS_PIPER_OFFSCREEN_STOP",
          playbackId: playback.playbackId
        }).catch?.(() => {});
      } catch (_error) {}
      return true;
    }

    _finishLinuxPiperPreparedPlayback(activeGeneration, prepared) {
      if (activeGeneration !== this.generation) return;

      this._clearBoundaryClock();
      this.directActive = false;
      this.linuxPiperPausedInPlace = false;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperOffscreenPlayback = null;
      this.currentChunkIndex += 1;

      if (this.currentChunkIndex >= this.currentChunks.length) {
        this.currentChunks = [];
        this.currentOptions = null;
        this.linuxPiperPrepared.clear();
        this.onEnd?.();
        return;
      }

      // The extension-owned audio document now owns the inter-sentence
      // wall-clock pause and emits "ended" only after that gap. Continue
      // immediately here so background-tab throttling cannot collapse or
      // stretch the configured sentence pause.
      this._speakLinuxPiperChunk(activeGeneration);
    }

    _playLinuxPiperPreparedOffscreen(generation, prepared, reason) {
      if (
        generation !== this.generation ||
        prepared.chunkIndex !== this.currentChunkIndex
      ) {
        return;
      }

      if (!prepared.audioBase64?.length) {
        this._failLinuxPiper(
          `page media rejected Piper WAV and no offscreen WAV copy was available: ${reason}`
        );
        return;
      }

      try {
        this.directAudio?.pause?.();
        this.directAudio?.removeAttribute?.("src");
        this.directAudio?.load?.();
      } catch (_error) {}
      this.directAudio = null;
      this._revokeObjectUrl();

      const playbackId =
        `piper-offscreen-${generation}-${prepared.chunkIndex}-${Date.now()}`;
      this.linuxPiperOffscreenPlayback = {
        playbackId,
        generation,
        chunkIndex: prepared.chunkIndex,
        currentTime: 0,
        paused: false,
        started: false,
        prepared
      };
      this.directBoundaryIndex = 0;
      this.currentChunkBoundaryIndex = -1;
      this.directActive = false;
      this.linuxPiperPausedInPlace = false;
      this.onStatus?.("Using extension audio fallback...");

      void root.chrome?.runtime?.sendMessage?.({
        type: "EDGE_TTS_PIPER_OFFSCREEN_PLAY",
        playbackId,
        audioChunks: prepared.audioBase64,
        boundaryOffsets: this.directBoundaries.map(
          (boundary) => Math.max(0, Number(boundary.offsetSeconds) || 0)
        ),
        sentencePauseMs: prepared.payload?.sentenceFinal === false
          ? 0
          : Math.max(
              0,
              Number(this.currentOptions?.sentencePauseMs) || 0
            ),
        playbackRate: this.directPlaybackRate,
        volume: Math.min(
          1,
          Math.max(0, Number(this.directOutputGain) || 0)
        )
      }).then((response) => {
        if (
          generation !== this.generation ||
          this.linuxPiperOffscreenPlayback?.playbackId !== playbackId
        ) {
          return;
        }
        if (!response?.accepted) {
          this._failLinuxPiper(
            `extension-owned playback rejected: ${response?.error || "unknown error"}`
          );
        }
      }).catch((error) => {
        if (
          generation !== this.generation ||
          this.linuxPiperOffscreenPlayback?.playbackId !== playbackId
        ) {
          return;
        }
        this._failLinuxPiper(
          `extension-owned playback failed: ${error?.message || String(error)}`
        );
      });
    }

    handleLinuxPiperOffscreenEvent(message) {
      const playback = this.linuxPiperOffscreenPlayback;
      if (
        !playback ||
        String(message?.playbackId || "") !== playback.playbackId ||
        playback.generation !== this.generation
      ) {
        return false;
      }

      const event = message.event || {};
      if (Number.isFinite(Number(event.currentTime))) {
        playback.currentTime = Math.max(0, Number(event.currentTime));
      }

      if (event.type === "time") {
        return true;
      }

      if (event.type === "started" || event.type === "resumed") {
        playback.paused = false;
        this.directActive = true;
        this.linuxPiperPausedInPlace = false;

        if (!playback.started) {
          playback.started = true;
          this.onStart?.(
            playback.prepared?.payload?.segments?.[0],
            Math.max(
              0,
              (root.performance?.now?.() ?? Date.now()) - this.requestedAt
            )
          );
          this._fillLinuxPiperPrefetch(this.generation);

          // Defensive fallback: even if a backend returned no word boundaries,
          // never start audible speech with no visible highlight at all.
          if (
            this.directBoundaries.length === 0 &&
            playback.prepared?.payload?.segments?.[0]
          ) {
            this.onBoundary?.(
              playback.prepared.payload.segments[0],
              {
                type: "linux-piper-boundary-fallback",
                directAudio: true,
                audioOffset: 0,
                duration: 0,
                spokenText: ""
              }
            );
          }
        }

        this.onStatus?.("Reading");
        return true;
      }

      if (event.type === "boundary") {
        const index = Math.max(0, Number(event.index) || 0);
        const boundary = this.directBoundaries[index];
        if (boundary?.segment) {
          this.currentChunkBoundaryIndex = index;
          this.onBoundary?.(boundary.segment, {
            type: "linux-piper-offscreen-boundary",
            directAudio: true,
            audioOffset: boundary.offsetSeconds,
            duration: boundary.durationSeconds,
            spokenText: boundary.text
          });
        }
        return true;
      }

      if (event.type === "paused") {
        playback.paused = true;
        this.directActive = false;
        this.linuxPiperPausedInPlace = true;
        this._clearBoundaryClock();
        return true;
      }

      if (event.type === "ended") {
        const prepared = playback.prepared;
        this._finishLinuxPiperPreparedPlayback(this.generation, prepared);
        return true;
      }

      if (event.type === "stopped") {
        this.directActive = false;
        this._clearBoundaryClock();
        this.linuxPiperOffscreenPlayback = null;
        return true;
      }

      if (event.type === "error") {
        this.linuxPiperOffscreenPlayback = null;
        this._failLinuxPiper(
          event.message || "Extension-owned Piper playback failed."
        );
        return true;
      }

      return false;
    }

    _playLinuxPiperPrepared(generation, prepared) {
      if (
        generation !== this.generation ||
        prepared.chunkIndex !== this.currentChunkIndex
      ) {
        return;
      }

      this.directActive = false;
      this.linuxPiperPlaybackIndex = prepared.chunkIndex;
      this.linuxPiperPausedInPlace = false;
      this.directBoundaries = this._preparedLinuxPiperBoundaries(prepared);
      this.directBoundaryIndex = 0;
      this.currentChunkBoundaryIndex = -1;

      // Piper WAV playback belongs to the extension, not to arbitrary pages.
      // The previous "page <audio> first, offscreen fallback second" design had
      // a real startup race: page audio could reject with NotAllowedError and
      // mark the reader Paused just before a media-safety error transferred the
      // same WAV to offscreen playback. Audio would then play while the reader
      // intentionally ignored start/boundary events because it believed it was
      // paused. Use the extension-owned player from the outset.
      this.onStatus?.(
        prepared.prefetch
          ? "Playing prefetched Piper audio..."
          : "Playing Piper audio..."
      );
      this._playLinuxPiperPreparedOffscreen(
        generation,
        prepared,
        "primary Piper playback"
      );
    }

    _failLinuxPiper(message) {
      const failedPayload = this.currentChunks?.[this.currentChunkIndex];
      try {
        void root.chrome?.storage?.session?.set?.({
          edgeTtsLastPiperFailureV1: {
            at: Date.now(),
            message: String(message || "Unknown Piper failure"),
            chunkIndex: this.currentChunkIndex,
            textLength: String(failedPayload?.text || "").length,
            text: String(failedPayload?.text || ""),
            playbackIndex: this.linuxPiperPlaybackIndex,
            preparedChunks: this.linuxPiperPrepared?.size || 0,
            activeRequests: this.linuxPiperRequests?.size || 0
          }
        });
      } catch (_error) {}

      this._clearLinuxPiperSentencePause();
      this._stopLinuxPiperOffscreenPlayback();
      for (const request of this.linuxPiperRequests.values()) {
        if (request.timeoutId) root.clearTimeout(request.timeoutId);
      }
      this.linuxPiperRequests.clear();
      this.linuxPiperPrepared.clear();
      this.linuxPiperRequest = null;
      this.linuxPiperPlaybackIndex = -1;
      this.linuxPiperPausedInPlace = false;
      this._resetDirectState({ keepMode: true });
      this.onError?.(new Error(`Linux Piper TTS failed: ${message}`));
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
        request.audioBase64.push(String(event.data || ""));
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

      const improvedBoundaries = approximatePiperBoundaries(
        request.payload,
        event.durationMs
      );

      const prepared = {
        generation: request.generation,
        chunkIndex: request.chunkIndex,
        payload: request.payload,
        audio: request.audio,
        audioBase64: request.audioBase64,
        boundaries:
          improvedBoundaries.length > 0
            ? improvedBoundaries
            : request.boundaries,
        boundariesArePrepared: improvedBoundaries.length > 0,
        prefetch: request.prefetch
      };
      this.linuxPiperPrepared.set(request.chunkIndex, prepared);

      if (
        request.chunkIndex === this.currentChunkIndex &&
        this.linuxPiperPlaybackIndex !== this.currentChunkIndex
      ) {
        // The native helper is idle now. Start sentence N+1 before constructing
        // and starting playback for sentence N so synthesis overlaps as much
        // of the current sentence as possible.
        this._fillLinuxPiperPrefetch(request.generation);
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
      this.linuxPiperSpeakSerial += 1;
      this._clearLinuxPiperSentencePause();
      this._stopLinuxPiperOffscreenPlayback();
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
      this.linuxPiperSpeakSerial += 1;
      this._clearLinuxPiperSentencePause();
      this._stopLinuxPiperOffscreenPlayback();
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
    PIPER_SOFT_CLAUSE_CHARS,
    PIPER_HARD_CLAUSE_CHARS,
    splitPiperSentenceSegments,
    approximatePiperBoundaries,
    createPiperSentenceChunks,
    payloadForPiperSegments
  };
});
