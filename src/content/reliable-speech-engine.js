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
    return { ReliableSpeechEngine: null, isInternallyIdle };
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
  }

  return { ReliableSpeechEngine, isInternallyIdle };
});
