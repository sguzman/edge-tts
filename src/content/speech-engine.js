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

  function createUtterancePayload(block, startSegmentIndex) {
    const segments = block.segments.slice(startSegmentIndex);
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

  class SpeechEngine {
    constructor({ onBoundary, onEnd, onError }) {
      this.onBoundary = onBoundary;
      this.onEnd = onEnd;
      this.onError = onError;
      this.synth = root.speechSynthesis;
      this.currentUtterance = null;
      this.generation = 0;
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

    async waitForVoices(timeoutMs = 1500) {
      const existing = this.getVoices();
      if (existing.length > 0 || !this.synth) {
        return existing;
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.synth.removeEventListener("voiceschanged", finish);
          resolve(this.getVoices());
        };

        this.synth.addEventListener("voiceschanged", finish, { once: true });
        root.setTimeout(finish, timeoutMs);
      });
    }

    chooseVoices(documentLanguage, savedName) {
      const language = preferredLanguage(documentLanguage);
      return sortVoices(this.getVoices(), language, savedName);
    }

    cancel() {
      this.generation += 1;
      this.currentUtterance = null;
      this.synth?.cancel();
    }

    pause() {
      this.synth?.pause();
    }

    resume() {
      this.synth?.resume();
    }

    isPaused() {
      return Boolean(this.synth?.paused);
    }

    speak(block, startSegmentIndex, options) {
      if (!this.synth || typeof root.SpeechSynthesisUtterance !== "function") {
        this.onError?.(new Error("SpeechSynthesis is not available on this page."));
        return;
      }

      const payload = createUtterancePayload(block, startSegmentIndex);
      if (!payload.text) {
        this.onEnd?.();
        return;
      }

      this.cancel();
      const generation = this.generation;
      const utterance = new root.SpeechSynthesisUtterance(payload.text);
      utterance.rate = options.rate;
      if (options.voice) {
        utterance.voice = options.voice;
        utterance.lang = options.voice.lang;
      }

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
        this.onEnd?.();
      });

      utterance.addEventListener("error", (event) => {
        if (generation !== this.generation) return;
        this.currentUtterance = null;
        if (event.error !== "canceled" && event.error !== "interrupted") {
          this.onError?.(new Error(`Speech synthesis failed: ${event.error}`));
        }
      });

      this.currentUtterance = utterance;
      root.setTimeout(() => {
        if (generation === this.generation) {
          this.synth.speak(utterance);
        }
      }, 0);
    }
  }

  return {
    SpeechEngine,
    createUtterancePayload,
    isNaturalVoice,
    preferredLanguage,
    scoreVoice,
    sortVoices
  };
});
