(function attachFailSafeReader(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.Reader && api.FailSafeReaderApp) {
    root.EdgeTtsExtension.Reader.ReaderApp = api.FailSafeReaderApp;
  }
})(globalThis, function createFailSafeReaderApi(root) {
  const BaseReaderApp = root.EdgeTtsExtension?.Reader?.ReaderApp;
  const PLAYBACK_LIVENESS_TIMEOUT_MS = 7500;
  const FAILSAFE_RESTART_DELAY_MS = 150;

  function advanceCursorOneSegment(model, blockIndex, segmentIndex) {
    const blocks = model?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return null;
    }

    const currentBlock = blocks[blockIndex];
    if (currentBlock?.segments?.length) {
      const nextSegmentIndex = Number(segmentIndex) + 1;
      if (nextSegmentIndex >= 0 && nextSegmentIndex < currentBlock.segments.length) {
        return { blockIndex, segmentIndex: nextSegmentIndex };
      }
    }

    for (
      let nextBlockIndex = Number(blockIndex) + 1;
      nextBlockIndex < blocks.length;
      nextBlockIndex += 1
    ) {
      if (blocks[nextBlockIndex]?.segments?.length) {
        return { blockIndex: nextBlockIndex, segmentIndex: 0 };
      }
    }

    return null;
  }

  if (!BaseReaderApp) {
    return {
      FailSafeReaderApp: null,
      FAILSAFE_RESTART_DELAY_MS,
      PLAYBACK_LIVENESS_TIMEOUT_MS,
      advanceCursorOneSegment
    };
  }

  class FailSafeReaderApp extends BaseReaderApp {
    constructor() {
      super();
      this.playbackLivenessTimer = null;
      this.playbackLivenessSerial = 0;
      this.playbackLivenessTimeoutMs = PLAYBACK_LIVENESS_TIMEOUT_MS;
      this.failsafeRestartDelayMs = FAILSAFE_RESTART_DELAY_MS;
    }

    clearPlaybackLivenessWatchdog() {
      this.playbackLivenessSerial += 1;
      if (this.playbackLivenessTimer !== null) {
        root.clearTimeout(this.playbackLivenessTimer);
        this.playbackLivenessTimer = null;
      }
    }

    armPlaybackLivenessWatchdog() {
      if (this.playbackLivenessTimer !== null) {
        root.clearTimeout(this.playbackLivenessTimer);
        this.playbackLivenessTimer = null;
      }

      if (this.stopped || this.paused || !this.model) {
        return;
      }

      const serial = ++this.playbackLivenessSerial;
      const boundarySerial = this.boundarySerial;
      const cursor = {
        blockIndex: this.currentBlockIndex,
        segmentIndex: this.currentSegmentIndex
      };

      this.playbackLivenessTimer = root.setTimeout(() => {
        this.playbackLivenessTimer = null;
        if (
          serial !== this.playbackLivenessSerial ||
          this.stopped ||
          this.paused ||
          !this.model
        ) {
          return;
        }

        if (this.boundarySerial !== boundarySerial) {
          this.armPlaybackLivenessWatchdog();
          return;
        }

        const nextCursor = advanceCursorOneSegment(
          this.model,
          cursor.blockIndex,
          cursor.segmentIndex
        );

        if (!nextCursor) {
          this.finishDocument();
          return;
        }

        console.warn(
          `Edge Natural TTS reader-level liveness timeout at ${cursor.blockIndex}:${cursor.segmentIndex}; ` +
            `forcing continuation at ${nextCursor.blockIndex}:${nextCursor.segmentIndex}.`
        );

        // Invalidate every lower-level pending transition before replacing the
        // transport. This watchdog is deliberately independent of SpeechEngine:
        // even if Chromium cleared/stranded all engine timers, the reader itself
        // can still move the committed document cursor forward.
        if (Number.isFinite(Number(this.batchRequestSerial))) {
          this.batchRequestSerial += 1;
        }
        this.clearReliabilityTimers?.();
        this.activeBatchRequest = null;
        this.activeBatchEndBlockIndex = -1;
        this.currentBlockIndex = nextCursor.blockIndex;
        this.currentSegmentIndex = nextCursor.segmentIndex;
        this.speech?.cancel?.();
        this.toolbar?.setStatus?.("Recovering playback…");

        const restartSerial = ++this.playbackLivenessSerial;
        root.setTimeout(() => {
          if (
            restartSerial !== this.playbackLivenessSerial ||
            this.stopped ||
            this.paused ||
            !this.model
          ) {
            return;
          }
          this.speakCurrentPosition();
        }, Math.max(0, Number(this.failsafeRestartDelayMs) || 0));
      }, Math.max(100, Number(this.playbackLivenessTimeoutMs) || PLAYBACK_LIVENESS_TIMEOUT_MS));
    }

    speakCurrentPosition() {
      const result = super.speakCurrentPosition();
      this.armPlaybackLivenessWatchdog();
      return result;
    }

    handleSpeechStart(latencyMs) {
      const result = super.handleSpeechStart(latencyMs);
      this.armPlaybackLivenessWatchdog();
      return result;
    }

    handleBoundary(segment) {
      const result = super.handleBoundary(segment);
      this.armPlaybackLivenessWatchdog();
      return result;
    }

    handleBlockEnd() {
      this.clearPlaybackLivenessWatchdog();
      return super.handleBlockEnd();
    }

    playPause() {
      const result = super.playPause();
      if (this.stopped || this.paused) {
        this.clearPlaybackLivenessWatchdog();
      } else {
        this.armPlaybackLivenessWatchdog();
      }
      return result;
    }

    stop() {
      this.clearPlaybackLivenessWatchdog();
      return super.stop();
    }

    refreshText() {
      this.clearPlaybackLivenessWatchdog();
      return super.refreshText();
    }

    finishDocument() {
      this.clearPlaybackLivenessWatchdog();
      return super.finishDocument();
    }

    handleError(error) {
      this.clearPlaybackLivenessWatchdog();
      return super.handleError(error);
    }
  }

  return {
    FailSafeReaderApp,
    FAILSAFE_RESTART_DELAY_MS,
    PLAYBACK_LIVENESS_TIMEOUT_MS,
    advanceCursorOneSegment
  };
});
