(function attachWinNaturalEngine(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root.EdgeTtsExtension?.SpeechEngine && api.WinNaturalSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.WinNaturalSpeechEngine;
    root.EdgeTtsExtension.WinNatural = api;
  }
})(globalThis, function createWinNaturalEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;
  const createUtteranceChunks = speechModule?.createUtteranceChunks;
  const segmentIndexForCharIndex = root.EdgeTtsExtension?.TextModel?.segmentIndexForCharIndex;

  function voiceKey(voice) {
    return `${String(voice?.name || "").toLocaleLowerCase()}\u0000${String(voice?.lang || "").toLocaleLowerCase()}`;
  }
  function isWinNaturalVoice(voice) { return voice?.__edgeTtsSource === "win-natural"; }
  function nativeVoiceToCatalogVoice(raw) {
    const name = String(raw?.name || "").trim();
    const voiceId = String(raw?.id || "").trim();
    if (!name || !voiceId) return null;
    return { name, lang: String(raw?.lang || ""), localService: true, default: false,
      voiceURI: `win-natural:${voiceId}`, __edgeTtsSource: "win-natural", voiceId,
      eventTypes: ["start", "word", "sentence", "end"] };
  }
  function mergeVoices(base, native) {
    const result = [...(base || [])];
    const keys = new Set(result.map(voiceKey));
    for (const raw of native || []) {
      const voice = raw?.__edgeTtsSource === "win-natural" ? raw : nativeVoiceToCatalogVoice(raw);
      if (voice) {
        const key = voiceKey(voice);
        const existingIndex = result.findIndex((candidate) => voiceKey(candidate) === key);
        if (existingIndex < 0) result.push(voice);
        else if (result[existingIndex]?.__edgeTtsSource !== "win-natural") result[existingIndex] = voice;
        keys.add(key);
      }
    }
    return result;
  }
  function requestId(generation, chunkIndex) { return `${Date.now()}-${generation}-${chunkIndex}-${Math.random().toString(16).slice(2)}`; }
  function fromBase64(value) {
    const binary = root.atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {
    return { WinNaturalSpeechEngine: null, isWinNaturalVoice, mergeVoices, nativeVoiceToCatalogVoice };
  }

  class WinNaturalSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.winNaturalVoices = [];
      this.winNaturalVoiceListeners = new Set();
      this.winNaturalVoicesLoaded = false;
      this.winNaturalVoiceRequest = null;
      this.winNaturalRequest = null;
      void this.refreshWinNaturalVoices();
    }
    getVoices() { return mergeVoices(super.getVoices?.() || [], this.winNaturalVoices); }
    onVoicesChanged(callback) {
      const unsubscribe = super.onVoicesChanged?.(callback) || (() => {});
      this.winNaturalVoiceListeners.add(callback);
      if (this.winNaturalVoicesLoaded) root.queueMicrotask?.(() => callback(this.getVoices()));
      return () => { unsubscribe(); this.winNaturalVoiceListeners.delete(callback); };
    }
    async refreshWinNaturalVoices() {
      if (this.winNaturalVoiceRequest) return this.winNaturalVoiceRequest;
      if (!root.chrome?.runtime?.sendMessage) return this.winNaturalVoices;
      this.winNaturalVoiceRequest = Promise.resolve(root.chrome.runtime.sendMessage({ type: "EDGE_TTS_WIN_NATURAL_VOICES" }))
        .then((response) => {
          this.winNaturalVoices = (response?.voices || []).map(nativeVoiceToCatalogVoice).filter(Boolean);
          this.winNaturalVoicesLoaded = true;
          for (const listener of this.winNaturalVoiceListeners) { try { listener(this.getVoices()); } catch (_error) {} }
          return this.winNaturalVoices;
        }).catch(() => this.winNaturalVoices).finally(() => { this.winNaturalVoiceRequest = null; });
      return this.winNaturalVoiceRequest;
    }
    canPlayIndependently(voice) { return isWinNaturalVoice(voice) || super.canPlayIndependently?.(voice); }
    speak(block, startSegmentIndex, options = {}) {
      if (!isWinNaturalVoice(options.voice)) return super.speak(block, startSegmentIndex, options);
      const chunks = createUtteranceChunks(block, startSegmentIndex, options?.chunkOptions);
      if (!chunks.length) { this.onEnd?.(); return; }
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
      this.directOutputGain = Number.isFinite(configuredVolume) ? Math.min(2, Math.max(0, configuredVolume)) : 1;
      this._speakWinNaturalChunk(generation);
    }
    _speakWinNaturalChunk(generation) {
      if (generation !== this.generation) return;
      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (!payload) { this.directActive = false; this.directSessionMode = true; this.onEnd?.(); return; }
      const request = requestId(generation, this.currentChunkIndex);
      this.winNaturalRequest = { requestId: request, generation, payload, audio: [], boundaries: [] };
      Promise.resolve(root.chrome?.runtime?.sendMessage?.({ type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE", requestId: request,
        text: payload.text, voiceId: this.currentOptions?.voice?.voiceId, lang: this.currentOptions?.voice?.lang, rate: this.currentOptions?.rate }))
        .then((response) => { if (!response?.accepted && generation === this.generation) this._failWinNatural("Windows Natural helper refused the request."); })
        .catch((error) => { if (generation === this.generation) this._failWinNatural(error?.message || String(error)); });
    }
    _failWinNatural(message) { this._resetDirectState({ keepMode: true }); this.winNaturalRequest = null; this.onError?.(new Error(`Windows Natural TTS failed: ${message}`)); }
    handleWinNaturalEvent(message) {
      const request = this.winNaturalRequest;
      if (!this.directSessionMode || !request || message?.requestId !== request.requestId || request.generation !== this.generation) return false;
      const event = message.event || {};
      if (event.type === "boundary") { request.boundaries.push(event); return true; }
      if (event.type === "audioChunk") { request.audio.push(fromBase64(event.data)); return true; }
      if (event.type === "error" || event.type === "cancelled") { this._failWinNatural(event.message || event.errorMessage || event.type); return true; }
      if (event.type !== "synthesisEnd") return false;
      const payload = request.payload;
      this.directBoundaries = request.boundaries.map((boundary) => {
        const charIndex = Math.max(0, Number(boundary.charIndex) || 0);
        const index = typeof segmentIndexForCharIndex === "function" ? segmentIndexForCharIndex(payload.starts, charIndex) : 0;
        return { segment: payload.segments?.[index], offsetSeconds: Math.max(0, Number(boundary.audioPositionMs) || 0) / 1000,
          durationSeconds: Math.max(0, Number(boundary.durationMs) || 0) / 1000, text: boundary.text || "" };
      });
      this.directBoundaryIndex = 0;
      const blob = new Blob(request.audio, { type: "audio/wav" });
      this._revokeObjectUrl(); this.directObjectUrl = root.URL.createObjectURL(blob);
      const audio = this._ensureAudioElement(); audio.src = this.directObjectUrl; audio.playbackRate = this.directPlaybackRate; this._applyDirectGain();
      const generation = request.generation;
      audio.onended = () => { if (generation !== this.generation) return; this._clearBoundaryClock(); this.directActive = false; this.winNaturalRequest = null; this.currentChunkIndex += 1; if (this.currentChunkIndex >= this.currentChunks.length) { this.currentChunks = []; this.currentOptions = null; this.onEnd?.(); } else root.setTimeout(() => this._speakWinNaturalChunk(generation), 0); };
      audio.onerror = () => { if (generation === this.generation) this._failWinNatural("WAV playback failed"); };
      void audio.play().then(() => { if (generation !== this.generation) return; this.onStart?.(payload.segments?.[0], Math.max(0, (root.performance?.now?.() ?? Date.now()) - this.requestedAt)); this._startBoundaryClock(generation); }).catch((error) => this._failWinNatural(error?.message || String(error)));
      return true;
    }
    cancel() { if (this.directSessionMode) { try { root.chrome?.runtime?.sendMessage?.({ type: "EDGE_TTS_WIN_NATURAL_STOP", requestId: this.winNaturalRequest?.requestId || null }); } catch (_error) {} this.winNaturalRequest = null; } return super.cancel?.(); }
    abandon() { return this.cancel(); }
  }
  return { WinNaturalSpeechEngine, isWinNaturalVoice, mergeVoices, nativeVoiceToCatalogVoice };
});
