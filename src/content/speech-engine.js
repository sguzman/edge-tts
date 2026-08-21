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

  function separatorForSegments(left, right) {
    if (
      left?.blockIndex !== undefined &&
      right?.blockIndex !== undefined &&
      left.blockIndex !== right.blockIndex
    ) {
      return "\n\n";
    }
    return " ";
  }

  function createPayloadFromSegments(segments) {
    const starts = [];
    let text = "";

    segments.forEach((segment, index) => {
      if (index > 0) {
        text += separatorForSegments(segments[index - 1], segment);
      }
      starts.push(text.length);
      text += segment.text;
    });

    return { text, starts, segments };
  }

  function createUtterancePayload(block, startSegmentIndex) {
    return createPayloadFromSegments(block.segments.slice(startSegmentIndex));
  }

  function createSpeechBatch(
    blocks,
    startBlockIndex,
    startSegmentIndex,
    { minChars = 1200, maxChars = Math.max(2400, minChars * 2) } = {}
  ) {
    const targetMin = Math.max(1, Math.floor(Number(minChars) || 1200));
    const targetMax = Math.max(targetMin, Math.floor(Number(maxChars) || targetMin * 2));
    const segments = [];
    let charLength = 0;
    let endBlockIndex = -1;

    for (let blockIndex = startBlockIndex; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (!block?.segments?.length) continue;

      const firstSegmentIndex = blockIndex === startBlockIndex ? startSegmentIndex : 0;
      const blockSegments = block.segments.slice(firstSegmentIndex);
      if (blockSegments.length === 0) continue;

      const blockPayload = createPayloadFromSegments(blockSegments);
      const joinLength = segments.length
        ? separatorForSegments(segments[segments.length - 1], blockSegments[0]).length
        : 0;
      const projectedLength = charLength + joinLength + blockPayload.text.length;

      // Do not drag a large following paragraph into a nearly-complete batch.
      // It can be synthesized efficiently as the first block of the next batch.
      if (segments.length > 0 && projectedLength > targetMax) {
        break;
      }

      segments.push(...blockSegments);
      charLength = projectedLength;
      endBlockIndex = blockIndex;

      if (charLength >= targetMin) {
        break;
      }
    }

    if (segments.length === 0) {
      return null;
    }

    return {
      segments,
      startBlockIndex,
      endBlockIndex,
      charLength
    };
  }

  function createUtteranceChunks(
    block,
    startSegmentIndex,
    { firstChunkMaxChars = 900, maxChars = 1800, emergencyMaxChars = 8000 } = {}
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
      if (current.length > 0) {
        currentLength += separatorForSegments(current[current.length - 1], segment).length;
      }
      currentLength += segment.text.length;
      current.push(segment);

      const blockEnds = Boolean(next && segment.blockIndex !== next.blockIndex);
      const sentenceEnds =
        !next ||
        blockEnds ||
        segment.sentenceIndex !== next.sentenceIndex ||
        /[.!?]["'”’\)\]]*$/.test(segment.text);
      const targetMax = chunks.length === 0 ? firstChunkMaxChars : maxChars;
      const reachedSentenceBoundary = currentLength >= targetMax && sentenceEnds;
      const reachedEmergencyLimit =
        currentLength >= Math.max(targetMax, Number(emergencyMaxChars) || 8000);

      // The normal target is soft: once it is reached, wait for the end of the
      // current sentence/paragraph before starting another online request. A
      // mid-sentence split causes a very noticeable Natural-voice startup gap.
      // Only pathological giant unpunctuated text is allowed to cross the much
      // larger emergency ceiling.
      if (reachedSentenceBoundary || reachedEmergencyLimit || !next) {
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

      const chunks = createUtteranceChunks(block, startSegmentIndex, options?.chunkOptions);
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
    createSpeechBatch,
    createUtteranceChunks,
    createUtterancePayload,
    isNaturalVoice,
    preferredLanguage,
    scoreVoice,
    sortVoices
  };
});