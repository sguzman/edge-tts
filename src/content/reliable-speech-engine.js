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

  // Batch size and transport size are separate concerns. A large logical batch
  // reduces paragraph startup gaps, while the browser receives moderately-sized
  // utterances so one giant remote request cannot wedge the Natural voice.
  const REMOTE_VOICE_TARGET_CHARS = 900;
  const REMOTE_VOICE_HARD_MAX_CHARS = 1200;

  function isInternallyIdle(engine) {
    return Boolean(
      engine &&
        engine.currentChunkIndex === -1 &&
        Array.isArray(engine.currentChunks) &&
        engine.currentChunks.length === 0 &&
        engine.currentOptions === null
    );
  }

  function isRemoteVoice(voice) {
    if (!voice) return false;
    if (voice.localService === false) return true;
    return /\b(natural|online)\b/i.test(String(voice.name || ""));
  }

  function safeChunkOptionsForVoice(voice, chunkOptions = {}) {
    if (!isRemoteVoice(voice)) {
      return { ...chunkOptions };
    }

    const requestedFirst = Number(chunkOptions.firstChunkMaxChars);
    const requestedNext = Number(chunkOptions.maxChars);
    const requestedEmergency = Number(chunkOptions.emergencyMaxChars);

    return {
      ...chunkOptions,
      firstChunkMaxChars: Number.isFinite(requestedFirst)
        ? Math.min(requestedFirst, REMOTE_VOICE_TARGET_CHARS)
        : REMOTE_VOICE_TARGET_CHARS,
      maxChars: Number.isFinite(requestedNext)
        ? Math.min(requestedNext, REMOTE_VOICE_TARGET_CHARS)
        : REMOTE_VOICE_TARGET_CHARS,
      emergencyMaxChars: Number.isFinite(requestedEmergency)
        ? Math.min(requestedEmergency, REMOTE_VOICE_HARD_MAX_CHARS)
        : REMOTE_VOICE_HARD_MAX_CHARS
    };
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

    if (remainingAfterBoundary <= 1) {
      return { action: "complete", restartIndex: -1 };
    }

    return { action: "resume", restartIndex: nextIndex };
  }

  function isSpontaneousRecoverableError(errorName) {
    return errorName === "canceled" || errorName === "interrupted";
  }

  if (!BaseSpeechEngine) {
    return {
      ReliableSpeechEngine: null,
      DEFAULT_NO_BOUNDARY_STALL_MS,
      REMOTE_VOICE_TARGET_CHARS,
      REMOTE_VOICE_HARD_MAX_CHARS,
      isInternallyIdle,
      isRemoteVoice,
      isSpontaneousRecoverableError,
      prematureEndRecoveryPlan,
      recoveryKeyForCurrentSegment,
      safeChunkOptionsForVoice
    };
  }

  class ReliableSpeechEngine extends BaseSpeechEngine {
    speak(block, startSegmentIndex, options = {}) {
      const safeOptions = {
        ...options,
        chunkOptions: safeChunkOptionsForVoice(options.voice, options.chunkOptions)
      };
      return super.speak(block, startSegmentIndex, safeOptions);
    }

    cancel() {
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

    // Do not periodically call speechSynthesis.resume() while healthy speech is
    // already running. That workaround is invasive and can itself perturb an
    // Online/Natural voice. Liveness is enforced by progress watchdogs instead.
    startHeartbeat(generation) {
      if (this.heartbeatTimer !== null) {
        root.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (payload?.segments?.length) {
        if (this.currentChunkBoundaryIndex < 0) {
          this.currentChunkBoundaryIndex = 0;
          this.provisionalBoundaryActive = true;
        }

        if (this.provisionalBoundaryActive) {
          this.onBoundary?.(payload.segments[0], {
            synthetic: true,
            type: "utterance-start",
            charIndex: 0
          });
        }
      }

      this.armingFromUtteranceStart = true;
      try {
        this.armProgressWatchdog(generation);
      } finally {
        this.armingFromUtteranceStart = false;
      }
    }

    armProgressWatchdog(generation) {
      if (this.progressWatchdog !== null) {
        root.clearTimeout(this.progressWatchdog);
      }

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
      if (reason === "premature-end" && this.provisionalBoundaryActive) {
        // The transport reached `end` before any real word boundary confirmed
        // progress. The provisional cursor exists only for highlighting and
        // liveness; it must never be interpreted as a spoken token here.
        this.provisionalBoundaryActive = false;
        this.currentChunkBoundaryIndex = -1;
        return super.recoverCurrentChunk("end-without-confirmed-boundary");
      }

      if (reason === "premature-end") {
        const payload = this.currentChunks?.[this.currentChunkIndex];
        const plan = prematureEndRecoveryPlan(
          this.currentChunkBoundaryIndex,
          payload?.segments?.length || 0
        );

        this.provisionalBoundaryActive = false;

        if (plan.action === "complete") {
          this.recoveryKey = "";
          this.recoveryAttempts = 0;
          return this.advanceChunkAfterRecovery?.();
        }

        this.currentChunkBoundaryIndex = plan.restartIndex;
        this.recoveryKey = "";
        this.recoveryAttempts = 0;
        return super.recoverCurrentChunk(reason);
      }

      if (reason === "no-boundary-progress") {
        const key = recoveryKeyForCurrentSegment(this);
        if (key && key === this.recoveryKey && Number(this.recoveryAttempts) >= 1) {
          this.recoveryAttempts = Number.MAX_SAFE_INTEGER;
        }
      }

      this.provisionalBoundaryActive = false;
      return super.recoverCurrentChunk(reason);
    }

    speakCurrentChunk(generation) {
      super.speakCurrentChunk(generation);

      const utterance = this.currentUtterance;
      const payload = this.currentChunks?.[this.currentChunkIndex];
      if (!utterance?.addEventListener) {
        return;
      }

      // Mark the first token as provisional before Chromium receives the
      // utterance. If it immediately emits `end` without start/boundary events,
      // the base premature-end check can no longer mistake that transport for
      // successful playback. startHeartbeat emits the visible synthetic
      // boundary only once the utterance actually starts.
      if (this.currentChunkBoundaryIndex < 0 && payload?.segments?.length) {
        this.currentChunkBoundaryIndex = 0;
        this.provisionalBoundaryActive = true;
      }

      // The base engine intentionally ignores `canceled` and `interrupted`
      // errors. That creates a dead state when Chromium emits one spontaneously:
      // its handler clears the timers/current utterance and then does nothing.
      // Intentional cancels are already protected by a generation bump, so any
      // such error that still matches this generation must be recovered.
      utterance.addEventListener("error", (event) => {
        if (
          generation !== this.generation ||
          !isSpontaneousRecoverableError(event?.error)
        ) {
          return;
        }

        const currentPayload = this.currentChunks?.[this.currentChunkIndex];
        if (!currentPayload?.segments?.length) {
          this.advanceChunkAfterRecovery?.();
          return;
        }

        if (this.currentChunkBoundaryIndex < 0) {
          this.currentChunkBoundaryIndex = 0;
        }

        console.warn(
          `Edge Natural TTS recovering spontaneous speech ${event.error} instead of going idle.`
        );
        this.recoverCurrentChunk?.(`error:${event.error}`);
      });
    }
  }

  return {
    ReliableSpeechEngine,
    DEFAULT_NO_BOUNDARY_STALL_MS,
    REMOTE_VOICE_TARGET_CHARS,
    REMOTE_VOICE_HARD_MAX_CHARS,
    isInternallyIdle,
    isRemoteVoice,
    isSpontaneousRecoverableError,
    prematureEndRecoveryPlan,
    recoveryKeyForCurrentSegment,
    safeChunkOptionsForVoice
  };
});
