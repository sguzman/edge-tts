(function attachBoundarylessFallback(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  api.installBoundarylessFallback?.();
})(globalThis, function createBoundarylessFallbackApi(root) {
  const VISUAL_FALLBACK_DELAY_MS = 320;
  const MIN_VISUAL_STEP_MS = 140;
  const MAX_VISUAL_STEP_MS = 650;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function visualStepMs(segment, rate = 1) {
    const length = String(segment?.text || "").length;
    const normalizedRate = Math.max(0.25, Number(rate) || 1);
    const base = 175 + Math.min(length, 24) * 12;
    return clamp(base / normalizedRate, MIN_VISUAL_STEP_MS, MAX_VISUAL_STEP_MS);
  }

  function installSpeechPolicy(SpeechEngine) {
    const prototype = SpeechEngine?.prototype;
    if (!prototype || prototype.__edgeTtsBoundarylessSpeechInstalled) {
      return false;
    }

    const originalSpeakCurrentChunk = prototype.speakCurrentChunk;
    const originalStartHeartbeat = prototype.startHeartbeat;
    const originalRecoverCurrentChunk = prototype.recoverCurrentChunk;

    if (
      typeof originalSpeakCurrentChunk !== "function" ||
      typeof originalStartHeartbeat !== "function" ||
      typeof originalRecoverCurrentChunk !== "function"
    ) {
      return false;
    }

    Object.defineProperty(prototype, "__edgeTtsBoundarylessSpeechInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.speakCurrentChunk = function boundarylessAwareSpeakCurrentChunk(generation) {
      // Reset for every browser utterance. This flips to true only from the real
      // SpeechSynthesisUtterance `start` event via startHeartbeat().
      this.__edgeTtsTransportStarted = false;
      return originalSpeakCurrentChunk.call(this, generation);
    };

    prototype.startHeartbeat = function boundarylessAwareStartHeartbeat(generation) {
      this.__edgeTtsTransportStarted = true;
      return originalStartHeartbeat.call(this, generation);
    };

    prototype.recoverCurrentChunk = function boundarylessAwareRecovery(reason) {
      if (
        reason === "premature-end" &&
        this.provisionalBoundaryActive &&
        this.__edgeTtsTransportStarted
      ) {
        // Some Natural-voice content (especially code / ASCII / punctuation)
        // audibly completes after a real `start` while Chromium emits zero word
        // boundary callbacks. A subsequent `end` is completion, not evidence
        // that the whole transport should be replayed.
        this.provisionalBoundaryActive = false;
        this.recoveryKey = "";
        this.recoveryAttempts = 0;
        return this.advanceChunkAfterRecovery?.();
      }

      // If start never happened, keep the 0.3.16 recovery behavior: an `end`
      // without proof that the transport started must not advance unread text.
      return originalRecoverCurrentChunk.call(this, reason);
    };

    return true;
  }

  function installReaderVisualFallback(ReaderApp) {
    const prototype = ReaderApp?.prototype;
    if (!prototype || prototype.__edgeTtsBoundarylessVisualInstalled) {
      return false;
    }

    const originalHandleBoundary = prototype.handleBoundary;
    const originalSpeakCurrentPosition = prototype.speakCurrentPosition;
    const originalStop = prototype.stop;
    const originalHandleBlockEnd = prototype.handleBlockEnd;
    const originalFinishDocument = prototype.finishDocument;
    const originalHandleError = prototype.handleError;
    const originalRefreshText = prototype.refreshText;

    if (typeof originalHandleBoundary !== "function") {
      return false;
    }

    Object.defineProperty(prototype, "__edgeTtsBoundarylessVisualInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.clearBoundarylessVisualFallback = function clearBoundarylessVisualFallback() {
      this.__edgeTtsVisualSerial = (Number(this.__edgeTtsVisualSerial) || 0) + 1;
      if (this.__edgeTtsVisualTimer !== null && this.__edgeTtsVisualTimer !== undefined) {
        root.clearTimeout(this.__edgeTtsVisualTimer);
      }
      this.__edgeTtsVisualTimer = null;
    };

    prototype.startBoundarylessVisualFallback = function startBoundarylessVisualFallback() {
      this.clearBoundarylessVisualFallback();

      const payload = this.speech?.currentChunks?.[this.speech?.currentChunkIndex];
      const segments = payload?.segments;
      if (!Array.isArray(segments) || segments.length < 2 || this.stopped || this.paused) {
        return;
      }

      const serial = Number(this.__edgeTtsVisualSerial) || 0;
      let index = 1;

      const step = () => {
        if (
          serial !== this.__edgeTtsVisualSerial ||
          this.stopped ||
          this.paused ||
          !this.model ||
          index >= segments.length
        ) {
          this.__edgeTtsVisualTimer = null;
          return;
        }

        const segment = segments[index];
        const block = this.model?.blocks?.[segment?.blockIndex];
        if (block && segment) {
          // Visual-only fallback. Do NOT change currentBlockIndex,
          // currentSegmentIndex, boundarySerial, or speech recovery state.
          this.highlighter?.highlight?.(block, segment);
        }

        const delay = visualStepMs(segment, this.settings?.rate);
        index += 1;
        this.__edgeTtsVisualTimer = root.setTimeout(step, delay);
      };

      this.__edgeTtsVisualTimer = root.setTimeout(step, VISUAL_FALLBACK_DELAY_MS);
    };

    prototype.handleBoundary = function boundarylessAwareHandleBoundary(segment, ...rest) {
      const syntheticStart = this.speech?.provisionalBoundaryActive === true;
      if (!syntheticStart) {
        // A real Chromium boundary is authoritative and immediately disables
        // approximation for this transport.
        this.clearBoundarylessVisualFallback();
      }

      const result = originalHandleBoundary.call(this, segment, ...rest);
      if (syntheticStart) {
        this.startBoundarylessVisualFallback();
      }
      return result;
    };

    if (typeof originalSpeakCurrentPosition === "function") {
      prototype.speakCurrentPosition = function boundarylessAwareSpeakCurrentPosition(...args) {
        this.clearBoundarylessVisualFallback();
        return originalSpeakCurrentPosition.apply(this, args);
      };
    }

    for (const [name, original] of [
      ["stop", originalStop],
      ["handleBlockEnd", originalHandleBlockEnd],
      ["finishDocument", originalFinishDocument],
      ["handleError", originalHandleError],
      ["refreshText", originalRefreshText]
    ]) {
      if (typeof original !== "function") continue;
      prototype[name] = function boundarylessAwareTerminalMethod(...args) {
        this.clearBoundarylessVisualFallback();
        return original.apply(this, args);
      };
    }

    return true;
  }

  function installBoundarylessFallback() {
    const SpeechEngine = root.EdgeTtsExtension?.SpeechEngine?.SpeechEngine;
    const ReaderApp = root.EdgeTtsExtension?.Reader?.ReaderApp;
    return {
      speech: installSpeechPolicy(SpeechEngine),
      reader: installReaderVisualFallback(ReaderApp)
    };
  }

  return {
    MAX_VISUAL_STEP_MS,
    MIN_VISUAL_STEP_MS,
    VISUAL_FALLBACK_DELAY_MS,
    installBoundarylessFallback,
    installReaderVisualFallback,
    installSpeechPolicy,
    visualStepMs
  };
});
