(function attachReliableSpeechEngine(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.SpeechEngine && api.ReliableSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.ReliableSpeechEngine;
  }
})(globalThis, function createReliableSpeechEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;
  const DEFAULT_NO_BOUNDARY_STALL_MS = 8000;

  function isInternallyIdle(engine) {
    return Boolean(
      engine &&
        engine.currentChunkIndex === -1 &&
        Array.isArray(engine.currentChunks) &&
        engine.currentChunks.length === 0 &&
        engine.currentOptions === null
    );
  }

  if (!BaseSpeechEngine) {
    return {
      ReliableSpeechEngine: null,
      DEFAULT_NO_BOUNDARY_STALL_MS,
      isInternallyIdle
    };
  }

  class ReliableSpeechEngine extends BaseSpeechEngine {
    cancel() {
      // Base SpeechEngine.speak() begins every new session by calling cancel().
      // That is necessary when replacing active speech, but harmful immediately
      // after a batch completed normally: Chromium is still settling the online
      // voice and a global speechSynthesis.cancel() can prevent the next batch
      // from ever starting. A cleanly-ended session is already idle; only reset
      // our stale bookkeeping and leave the browser speech pipeline alone.
      if (isInternallyIdle(this)) {
        this.clearPlaybackTimers?.();
        this.generation += 1;
        this.currentUtterance = null;
        this.currentChunks = [];
        this.currentChunkIndex = -1;
        this.currentChunkBoundaryIndex = -1;
        this.currentOptions = null;
        this.recoveryKey = "";
        this.recoveryAttempts = 0;
        return;
      }

      return super.cancel();
    }

    armProgressWatchdog(generation) {
      if (this.progressWatchdog !== null) {
        root.clearTimeout(this.progressWatchdog);
      }

      const stallTimeoutMs = Math.max(
        3000,
        Number(this.currentOptions?.stallTimeoutMs) || DEFAULT_NO_BOUNDARY_STALL_MS
      );

      this.progressWatchdog = root.setTimeout(() => {
        this.progressWatchdog = null;
        if (
          generation !== this.generation ||
          !this.currentUtterance ||
          this.synth?.paused
        ) {
          return;
        }

        // Unlike the base implementation, a missing boundary is itself a stall.
        // Edge can play Natural-voice audio after `start` while never emitting a
        // word boundary. Retrying must therefore not depend on already having a
        // real boundary event.
        this.recoverCurrentChunk?.(
          this.currentChunkBoundaryIndex < 0 ? "no-boundary-progress" : "stalled"
        );
      }, stallTimeoutMs);
    }

    startHeartbeat(generation) {
      super.startHeartbeat(generation);

      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (
        this.currentChunkBoundaryIndex < 0 &&
        payload?.segments?.length
      ) {
        // Treat audio start as a provisional first-token boundary. This keeps
        // the model cursor and highlighting monotonic even when Chromium fails
        // to emit its normal `boundary` events. A real boundary immediately
        // replaces this provisional position if/when one arrives.
        this.currentChunkBoundaryIndex = 0;
        this.onBoundary?.(payload.segments[0], {
          synthetic: true,
          type: "utterance-start",
          charIndex: 0
        });
      }

      // Arm progress from `start`, not from the first real boundary. Otherwise
      // an utterance that produces audio but zero boundary events can hang
      // forever and repeatedly restart from the same sentence.
      this.armProgressWatchdog(generation);
    }
  }

  return {
    ReliableSpeechEngine,
    DEFAULT_NO_BOUNDARY_STALL_MS,
    isInternallyIdle
  };
});
