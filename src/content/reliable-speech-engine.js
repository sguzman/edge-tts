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
  const DEFAULT_NO_BOUNDARY_STALL_MS = 6000;

  function isInternallyIdle(engine) {
    return Boolean(
      engine &&
        engine.currentChunkIndex === -1 &&
        Array.isArray(engine.currentChunks) &&
        engine.currentChunks.length === 0 &&
        engine.currentOptions === null
    );
  }

  function recoveryKeyForCurrentSegment(engine) {
    const payload = engine?.currentChunks?.[engine.currentChunkIndex];
    if (!payload?.segments?.length) return "";
    const index = Math.min(
      Math.max(Number(engine.currentChunkBoundaryIndex) || 0, 0),
      payload.segments.length - 1
    );
    const segment = payload.segments[index];
    return `${segment.blockIndex ?? "?"}:${segment.segmentIndex ?? "?"}:${segment.text ?? ""}`;
  }

  function prematureEndRecoveryPlan(boundaryIndex, segmentCount) {
    const count = Math.max(0, Math.floor(Number(segmentCount) || 0));
    const boundary = Math.floor(Number(boundaryIndex));

    if (count === 0 || !Number.isInteger(boundary) || boundary < 0) {
      return { action: "complete", restartIndex: -1 };
    }

    const nextIndex = boundary + 1;
    const remainingAfterBoundary = count - nextIndex;

    // A normal end event is authoritative enough when only the final token lacks
    // a boundary callback. Replaying that tail token is the source of the creepy
    // "word... word... word" echo seen at paragraph/chunk boundaries.
    if (remainingAfterBoundary <= 1) {
      return { action: "complete", restartIndex: -1 };
    }

    // If the end really arrived suspiciously early, resume from the first token
    // after the last confirmed boundary. Never replay the already-confirmed token.
    return { action: "resume", restartIndex: nextIndex };
  }

  if (!BaseSpeechEngine) {
    return {
      ReliableSpeechEngine: null,
      DEFAULT_NO_BOUNDARY_STALL_MS,
      isInternallyIdle,
      prematureEndRecoveryPlan,
      recoveryKeyForCurrentSegment
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
        this.provisionalBoundaryActive = false;
        return;
      }

      return super.cancel();
    }

    armProgressWatchdog(generation) {
      if (this.progressWatchdog !== null) {
        root.clearTimeout(this.progressWatchdog);
      }

      // Base boundary events call this method too. Any arm that did not come
      // directly from startHeartbeat represents real boundary progress and
      // supersedes the provisional audio-start cursor.
      if (!this.armingFromUtteranceStart) {
        this.provisionalBoundaryActive = false;
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

        this.recoverCurrentChunk?.(
          this.provisionalBoundaryActive ? "no-boundary-progress" : "stalled"
        );
      }, stallTimeoutMs);
    }

    recoverCurrentChunk(reason) {
      if (reason === "premature-end") {
        const payload = this.currentChunks?.[this.currentChunkIndex];
        const plan = prematureEndRecoveryPlan(
          this.currentChunkBoundaryIndex,
          payload?.segments?.length || 0
        );

        this.provisionalBoundaryActive = false;

        if (plan.action === "complete") {
          // The utterance emitted a real `end`; do not second-guess a missing
          // final boundary by replaying the tail word. Move to the next chunk.
          this.recoveryKey = "";
          this.recoveryAttempts = 0;
          return this.advanceChunkAfterRecovery?.();
        }

        // Base recovery starts exactly at currentChunkBoundaryIndex. Point it at
        // the first token AFTER the last confirmed token so a premature-end
        // recovery cannot duplicate already-heard speech.
        this.currentChunkBoundaryIndex = plan.restartIndex;
        this.recoveryKey = "";
        this.recoveryAttempts = 0;
        return super.recoverCurrentChunk(reason);
      }

      if (reason === "no-boundary-progress") {
        const key = recoveryKeyForCurrentSegment(this);

        // The first boundary-less playback gets one normal retry. If the same
        // provisional token starts audio again and still yields no real word
        // boundaries, force the base recovery ladder into its one-token escape
        // rather than replaying the same broken sentence through every chunk
        // size. The base method will observe attempts > its retry ceiling and
        // skip exactly one token before continuing.
        if (key && key === this.recoveryKey && Number(this.recoveryAttempts) >= 1) {
          this.recoveryAttempts = Number.MAX_SAFE_INTEGER;
        }
      }

      this.provisionalBoundaryActive = false;
      return super.recoverCurrentChunk(reason);
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
        this.provisionalBoundaryActive = true;
        this.onBoundary?.(payload.segments[0], {
          synthetic: true,
          type: "utterance-start",
          charIndex: 0
        });
      }

      // Arm progress from `start`, not from the first real boundary. Otherwise
      // an utterance that produces audio but zero boundary events can hang
      // forever and repeatedly restart from the same sentence.
      this.armingFromUtteranceStart = true;
      try {
        this.armProgressWatchdog(generation);
      } finally {
        this.armingFromUtteranceStart = false;
      }
    }
  }

  return {
    ReliableSpeechEngine,
    DEFAULT_NO_BOUNDARY_STALL_MS,
    isInternallyIdle,
    prematureEndRecoveryPlan,
    recoveryKeyForCurrentSegment
  };
});
