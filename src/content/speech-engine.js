(function attachSpeechEngine(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension) {
    root.EdgeTtsExtension.SpeechEngine = api;
  }
})(globalThis, function createSpeechEngineApi(root) {
  function isNaturalVoice(voice) {
    return /\b(natural|online)\b/i.test(voice.name || "");
  }

  function preferredLanguage(documentLanguage) {
    const candidate = documentLanguage || root.navigator?.language || "en-US";
    return candidate.replace("_", "-");
  }

  function scoreVoice(voice, language, savedName) {
    let score = 0;
    const shortLanguage = language.split("-")[0].toLowerCase();
    const voiceLanguage = (voice.lang || "").toLowerCase();

    if (savedName && voice.name === savedName) score += 10_000;
    if (isNaturalVoice(voice)) score += 1_000;
    if (voiceLanguage === language.toLowerCase()) score += 250;
    if (voiceLanguage.startsWith(shortLanguage)) score += 100;
    if (/microsoft/i.test(voice.name || "")) score += 20;
    if (voice.default) score += 5;

    return score;
  }

  function sortVoices(voices, language, savedName) {
    return [...voices].sort(
      (left, right) => scoreVoice(right, language, savedName) - scoreVoice(left, language, savedName)
    );
  }

  function createPayloadFromSegments(segments) {
    const starts = [];
    let text = "";

    segments.forEach((segment, index) => {
      if (index > 0) {
        text += " ";
      }
      starts.push(text.length);
      text += segment.text;
    });

    return { text, starts, segments };
  }

  function createUtterancePayload(block, startSegmentIndex) {
    return createPayloadFromSegments(block.segments.slice(startSegmentIndex));
  }

  function createUtteranceChunks(
    block,
    startSegmentIndex,
    { firstChunkMaxChars = 900, maxChars = 1800, hardLimitFactor = 1.35 } = {}
  ) {
    const remaining = block.segments.slice(startSegmentIndex);
    if (remaining.length === 0) return [];

    const chunks = [];
    let current = [];
    let currentLength = 0;

    function flush() {
      if (current.length === 0) return;
      chunks.push(createPayloadFromSegments(current));
      current = [];
      currentLength = 0;
    }

    for (let index = 0; index < remaining.length; index += 1) {
      const segment = remaining[index];
      const next = remaining[index + 1];
      currentLength += (current.length > 0 ? 1 : 0) + segment.text.length;
      current.push(segment);

      const sentenceEnds =
        !next ||
        segment.sentenceIndex !== next.sentenceIndex ||
        /[.!?]["'”’\)\]]*$/.test(segment.text);
      const targetMax = chunks.length === 0 ? firstChunkMaxChars : maxChars;
      const reachedSentenceBoundary = currentLength >= targetMax && sentenceEnds;
      const reachedHardLimit = currentLength >= Math.ceil(targetMax * hardLimitFactor);

      // Keep several sentences inside one utterance. Edge's Online (Natural)
      // voices can incur a fresh startup delay at each utterance boundary.
      if (reachedSentenceBoundary || reachedHardLimit || !next) {
        flush();
      }
    }

    return chunks;
  }

  class SpeechEngine {
    constructor({ onBoundary, onEnd, onError, onStart }) {
      this.onBoundary = onBoundary;
      this.onEnd = onEnd;
      this.onError = onError;
      this.onStart = onStart;
      this.synth = root.speechSynthesis;
      this.currentUtterance = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentOptions = null;
      this.generation = 0;
      this.requestedAt = 0;
    }

    getVoices() {
      return this.synth ? this.synth.getVoices() : [];
    }

    onVoicesChanged(callback) {
      if (!this.synth) {
        return () => {};
      }

      const listener = () => callback(this.getVoices());
      this.synth.addEventListener("voiceschanged", listener);
      return () => this.synth.removeEventListener("voiceschanged", listener);
    }

    async waitForVoices(timeoutMs = 350, predicate = (voices) => voices.length > 0) {
      const existing = this.getVoices();
      if (!this.synth || predicate(existing)) {
        return existing;
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          const voices = this.getVoices();
          if (!predicate(voices)) return;
          settled = true;
          this.synth.removeEventListener("voiceschanged", finish);
          root.clearTimeout(timeoutId);
          resolve(voices);
        };
        const timeoutFinish = () => {
          if (settled) return;
          settled = true;
          this.synth.removeEventListener("voiceschanged", finish);
          resolve(this.getVoices());
        };
        const timeoutId = root.setTimeout(timeoutFinish, timeoutMs);
        this.synth.addEventListener("voiceschanged", finish);
      });
    }

    chooseVoices(documentLanguage, savedName) {
      const language = preferredLanguage(documentLanguage);
      return sortVoices(this.getVoices(), language, savedName);
    }

    cancel() {
      this.generation += 1;
      this.currentUtterance = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentOptions = null;
      this.synth?.cancel();
    }

    pause() {
      if (this.synth?.speaking && !this.synth.paused) {
        this.synth.pause();
      }
    }

    resume() {
      if (this.synth?.paused) {
        this.synth.resume();
      }
    }

    isPaused() {
      return Boolean(this.synth?.paused);
    }

    isSpeaking() {
      return Boolean(this.synth?.speaking);
    }

    speak(block, startSegmentIndex, options) {
      if (!this.synth || typeof root.SpeechSynthesisUtterance !== "function") {
        this.onError?.(new Error("SpeechSynthesis is not available on this page."));
        return;
      }

      const chunks = createUtteranceChunks(block, startSegmentIndex);
      if (chunks.length === 0) {
        this.onEnd?.();
        return;
      }

      this.cancel();
      const generation = this.generation;
      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this.speakCurrentChunk(generation);
    }

    speakCurrentChunk(generation) {
      if (generation !== this.generation) return;

      const payload = this.currentChunks[this.currentChunkIndex];
      if (!payload) {
        this.currentUtterance = null;
        this.currentChunks = [];
        this.currentChunkIndex = -1;
        this.currentOptions = null;
        this.onEnd?.();
        return;
      }

      const chunkIndex = this.currentChunkIndex;
      const utterance = new root.SpeechSynthesisUtterance(payload.text);
      utterance.rate = this.currentOptions.rate;
      if (this.currentOptions.voice) {
        utterance.voice = this.currentOptions.voice;
        utterance.lang = this.currentOptions.voice.lang;
      }

      utterance.addEventListener("start", () => {
        if (generation !== this.generation) return;
        if (chunkIndex === 0) {
          const startedAt = root.performance?.now?.() ?? Date.now();
          this.onStart?.(payload.segments[0], Math.max(0, startedAt - this.requestedAt));
        }
      });

      utterance.addEventListener("boundary", (event) => {
        if (generation !== this.generation) return;
        const localIndex = root.EdgeTtsExtension.TextModel.segmentIndexForCharIndex(
          payload.starts,
          event.charIndex
        );
        const segment = payload.segments[localIndex];
        if (segment) {
          this.onBoundary?.(segment, event);
        }
      });

      utterance.addEventListener("end", () => {
        if (generation !== this.generation) return;
        this.currentUtterance = null;
        this.currentChunkIndex += 1;

        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.currentChunkIndex = -1;
          this.currentOptions = null;
          this.onEnd?.();
          return;
        }

        // Submit the next chunk only after the current one has really ended.
        // Keeping a single utterance in speechSynthesis avoids Edge getting
        // wedged when pause/resume interacts with a queued online-voice stack.
        root.setTimeout(() => this.speakCurrentChunk(generation), 0);
      });

      utterance.addEventListener("error", (event) => {
        if (generation !== this.generation) return;
        this.currentUtterance = null;
        if (event.error !== "canceled" && event.error !== "interrupted") {
          this.cancel();
          this.onError?.(new Error(`Speech synthesis failed: ${event.error}`));
        }
      });

      this.currentUtterance = utterance;
      root.setTimeout(() => {
        if (generation === this.generation && this.currentUtterance === utterance) {
          this.synth.speak(utterance);
        }
      }, 0);
    }
  }

  return {
    SpeechEngine,
    createUtteranceChunks,
    createUtterancePayload,
    isNaturalVoice,
    preferredLanguage,
    scoreVoice,
    sortVoices
  };
});
