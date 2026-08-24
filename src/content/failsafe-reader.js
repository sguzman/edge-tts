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

  function isRecoverableReaderError(error) {
    return /^Speech synthesis failed:/i.test(String(error?.message || ""));
  }

  function blockText(block) {
    return String(block?.text || "").trim();
  }

  function sameBlockRole(left, right) {
    return String(left?.authorRole || "") === String(right?.authorRole || "");
  }

  function matchingSegmentPrefixLength(leftSegments, rightSegments) {
    const left = Array.isArray(leftSegments) ? leftSegments : [];
    const right = Array.isArray(rightSegments) ? rightSegments : [];
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && String(left[index]?.text || "") === String(right[index]?.text || "")) {
      index += 1;
    }
    return index;
  }

  function findFreshTerminalContinuation(previousModel, freshModel) {
    const previousBlocks = previousModel?.blocks;
    const freshBlocks = freshModel?.blocks;
    if (
      !Array.isArray(previousBlocks) ||
      previousBlocks.length === 0 ||
      !Array.isArray(freshBlocks) ||
      freshBlocks.length === 0
    ) {
      return null;
    }

    const previousLast = previousBlocks[previousBlocks.length - 1];
    const previousText = blockText(previousLast);
    if (!previousText) {
      return null;
    }

    // The normal dynamic-page case is that another readable block appeared
    // after the terminal block captured by the old snapshot. Match from the
    // end so repeated short messages earlier in a conversation do not confuse
    // the anchor.
    for (let index = freshBlocks.length - 1; index >= 0; index -= 1) {
      const freshBlock = freshBlocks[index];
      if (!sameBlockRole(previousLast, freshBlock) || blockText(freshBlock) !== previousText) {
        continue;
      }

      if (index + 1 < freshBlocks.length) {
        return {
          blockIndex: index + 1,
          segmentIndex: 0,
          reason: "appended-block"
        };
      }
      return null;
    }

    // A streaming ChatGPT response can grow the final paragraph itself rather
    // than append a new block. Continue at the first newly-added token when the
    // token prefix is stable; otherwise replay the old tail token once rather
    // than risk skipping text that changed while streaming.
    for (let index = freshBlocks.length - 1; index >= 0; index -= 1) {
      const freshBlock = freshBlocks[index];
      const freshText = blockText(freshBlock);
      if (
        !sameBlockRole(previousLast, freshBlock) ||
        !freshText.startsWith(previousText) ||
        freshText.length <= previousText.length
      ) {
        continue;
      }

      const previousSegments = previousLast?.segments || [];
      const freshSegments = freshBlock?.segments || [];
      const matchingPrefix = matchingSegmentPrefixLength(previousSegments, freshSegments);
      if (freshSegments.length === 0) {
        return null;
      }

      const segmentIndex =
        matchingPrefix >= previousSegments.length
          ? Math.min(previousSegments.length, freshSegments.length - 1)
          : Math.max(0, Math.min(previousSegments.length - 1, freshSegments.length - 1));

      return {
        blockIndex: index,
        segmentIndex,
        reason: "grown-terminal-block"
      };
    }

    return null;
  }

  if (!BaseReaderApp) {
    return {
      FailSafeReaderApp: null,
      FAILSAFE_RESTART_DELAY_MS,
      PLAYBACK_LIVENESS_TIMEOUT_MS,
      advanceCursorOneSegment,
      findFreshTerminalContinuation,
      isRecoverableReaderError,
      matchingSegmentPrefixLength
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

    scheduleForcedContinuation(cursor, status) {
      const nextCursor = advanceCursorOneSegment(
        this.model,
        cursor.blockIndex,
        cursor.segmentIndex
      );

      if (!nextCursor) {
        this.finishDocument();
        return false;
      }

      if (Number.isFinite(Number(this.batchRequestSerial))) {
        this.batchRequestSerial += 1;
      }
      this.clearReliabilityTimers?.();
      this.activeBatchRequest = null;
      this.activeBatchEndBlockIndex = -1;
      this.currentBlockIndex = nextCursor.blockIndex;
      this.currentSegmentIndex = nextCursor.segmentIndex;
      this.speech?.cancel?.();
      this.toolbar?.setStatus?.(status);

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

      return true;
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

        console.warn(
          `Edge Natural TTS reader-level liveness timeout at ${cursor.blockIndex}:${cursor.segmentIndex}; ` +
            "forcing continuation instead of waiting for manual Stop/Play."
        );

        this.scheduleForcedContinuation(cursor, "Recovering playback…");
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

      const previousModel = this.model;
      if (
        this.enabled &&
        !this.quitRequested &&
        previousModel?.profile === "chatgpt" &&
        typeof this.rebuildModel === "function"
      ) {
        try {
          this.rebuildModel();
          const continuation = findFreshTerminalContinuation(previousModel, this.model);
          if (continuation) {
            if (Number.isFinite(Number(this.batchRequestSerial))) {
              this.batchRequestSerial += 1;
            }
            this.clearReliabilityTimers?.();
            this.activeBatchRequest = null;
            this.activeBatchEndBlockIndex = -1;
            this.currentBlockIndex = continuation.blockIndex;
            this.currentSegmentIndex = continuation.segmentIndex;
            this.stopped = false;
            this.paused = false;
            this.speech?.cancel?.();
            this.toolbar?.setStatus?.("Continuing updated text…");

            console.warn(
              `Edge Natural TTS terminal snapshot was stale (${continuation.reason}); continuing automatically.`
            );

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
            return;
          }
        } catch (error) {
          console.warn("Edge Natural TTS could not verify the terminal text snapshot.", error);
          this.model = previousModel;
        }
      }

      root.__EDGE_TTS_LAST_TERMINAL__ = {
        at: Date.now(),
        reason: "verified-document-end",
        profile: this.model?.profile || previousModel?.profile || "unknown",
        blockCount: this.model?.blocks?.length || previousModel?.blocks?.length || 0
      };
      return super.finishDocument();
    }

    handleError(error) {
      this.clearPlaybackLivenessWatchdog();

      if (isRecoverableReaderError(error) && !this.stopped && !this.paused && this.model) {
        const cursor = {
          blockIndex: this.currentBlockIndex,
          segmentIndex: this.currentSegmentIndex
        };
        console.warn(
          `Edge Natural TTS transport error at ${cursor.blockIndex}:${cursor.segmentIndex}; ` +
            "continuing automatically.",
          error
        );
        this.scheduleForcedContinuation(cursor, "Recovering speech error…");
        return;
      }

      root.__EDGE_TTS_LAST_TERMINAL__ = {
        at: Date.now(),
        reason: "unrecoverable-error",
        message: String(error?.message || error || "Unknown error"),
        blockIndex: this.currentBlockIndex,
        segmentIndex: this.currentSegmentIndex
      };
      return super.handleError(error);
    }
  }

  return {
    FailSafeReaderApp,
    FAILSAFE_RESTART_DELAY_MS,
    PLAYBACK_LIVENESS_TIMEOUT_MS,
    advanceCursorOneSegment,
    findFreshTerminalContinuation,
    isRecoverableReaderError,
    matchingSegmentPrefixLength
  };
});
