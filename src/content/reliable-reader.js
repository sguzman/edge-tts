(function attachReliableReader(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.Reader && api.ReliableReaderApp) {
    root.EdgeTtsExtension.Reader.ReaderApp = api.ReliableReaderApp;
  }
})(globalThis, function createReliableReaderApi(root) {
  const BaseReaderApp = root.EdgeTtsExtension?.Reader?.ReaderApp;
  const BATCH_TRANSITION_DELAY_MS = 75;
  const BATCH_START_TIMEOUT_MS = 6000;
  const BATCH_RETRY_DELAY_MS = 120;
  const MAX_AUDIO_NO_BOUNDARY_RETRIES = 2;

  function nextBatchBlockIndex(activeBatchEndBlockIndex, currentBlockIndex) {
    const completedEndBlock =
      Number.isInteger(activeBatchEndBlockIndex) && activeBatchEndBlockIndex >= 0
        ? activeBatchEndBlockIndex
        : currentBlockIndex;
    return completedEndBlock + 1;
  }

  function cursorKey(blockIndex, segmentIndex) {
    return `${Number(blockIndex)}:${Number(segmentIndex)}`;
  }

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

    for (let nextBlockIndex = Number(blockIndex) + 1; nextBlockIndex < blocks.length; nextBlockIndex += 1) {
      if (blocks[nextBlockIndex]?.segments?.length) {
        return { blockIndex: nextBlockIndex, segmentIndex: 0 };
      }
    }

    return null;
  }

  if (!BaseReaderApp) {
    return {
      ReliableReaderApp: null,
      BATCH_TRANSITION_DELAY_MS,
      BATCH_START_TIMEOUT_MS,
      MAX_AUDIO_NO_BOUNDARY_RETRIES,
      advanceCursorOneSegment,
      cursorKey,
      nextBatchBlockIndex
    };
  }

  class ReliableReaderApp extends BaseReaderApp {
    constructor() {
      super();
      this.batchTransitionTimer = null;
      this.batchStartWatchdog = null;
      this.batchRequestSerial = 0;
      this.activeBatchRequest = null;
      this.noBoundaryRetryKey = "";
      this.noBoundaryRetryCount = 0;
    }

    clearBatchTransitionTimer() {
      if (this.batchTransitionTimer !== null) {
        root.clearTimeout(this.batchTransitionTimer);
        this.batchTransitionTimer = null;
      }
    }

    clearBatchStartWatchdog() {
      if (this.batchStartWatchdog !== null) {
        root.clearTimeout(this.batchStartWatchdog);
        this.batchStartWatchdog = null;
      }
    }

    clearReliabilityTimers() {
      this.clearBatchTransitionTimer();
      this.clearBatchStartWatchdog();
    }

    resetNoBoundaryRecovery() {
      this.noBoundaryRetryKey = "";
      this.noBoundaryRetryCount = 0;
    }

    stop() {
      this.batchRequestSerial += 1;
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      this.clearReliabilityTimers();
      return super.stop();
    }

    refreshText() {
      this.batchRequestSerial += 1;
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      this.clearReliabilityTimers();
      return super.refreshText();
    }

    finishDocument() {
      this.batchRequestSerial += 1;
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      this.clearReliabilityTimers();
      return super.finishDocument();
    }

    handleError(error) {
      this.batchRequestSerial += 1;
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      this.clearReliabilityTimers();
      return super.handleError(error);
    }

    speakCurrentPosition() {
      this.clearBatchTransitionTimer();
      this.clearBatchStartWatchdog();

      const requestSerial = ++this.batchRequestSerial;
      const boundarySerialBeforeRequest = this.boundarySerial;
      const requestCursor = {
        blockIndex: this.currentBlockIndex,
        segmentIndex: this.currentSegmentIndex
      };
      this.activeBatchRequest = {
        serial: requestSerial,
        cursor: requestCursor,
        audioStarted: false
      };

      super.speakCurrentPosition();

      if (this.stopped || this.paused) {
        return;
      }

      // Edge can accept a Natural-voice utterance and even produce audio while
      // failing to emit word boundaries. If we simply retry from the last
      // confirmed cursor, that creates an infinite "broken sentence" loop.
      // Retry the same cursor once; if audio again starts with zero boundary
      // progress, sacrifice one token and move the model cursor forward.
      this.batchStartWatchdog = root.setTimeout(() => {
        this.batchStartWatchdog = null;
        const request = this.activeBatchRequest;
        if (
          requestSerial !== this.batchRequestSerial ||
          request?.serial !== requestSerial ||
          this.stopped ||
          this.paused ||
          this.boundarySerial !== boundarySerialBeforeRequest
        ) {
          return;
        }

        const key = cursorKey(request.cursor.blockIndex, request.cursor.segmentIndex);
        if (request.audioStarted) {
          if (key === this.noBoundaryRetryKey) {
            this.noBoundaryRetryCount += 1;
          } else {
            this.noBoundaryRetryKey = key;
            this.noBoundaryRetryCount = 1;
          }
        }

        console.warn(
          `Edge Natural TTS produced no boundary progress at ${key}; ` +
            `${request.audioStarted ? `audio retry ${this.noBoundaryRetryCount}` : "no audio start"}.`
        );

        this.speech?.cancel?.();

        let skippedStuckToken = false;
        if (
          request.audioStarted &&
          this.noBoundaryRetryCount >= MAX_AUDIO_NO_BOUNDARY_RETRIES
        ) {
          const nextCursor = advanceCursorOneSegment(
            this.model,
            request.cursor.blockIndex,
            request.cursor.segmentIndex
          );

          if (!nextCursor) {
            this.finishDocument();
            return;
          }

          this.currentBlockIndex = nextCursor.blockIndex;
          this.currentSegmentIndex = nextCursor.segmentIndex;
          this.activeBatchEndBlockIndex = -1;
          this.resetNoBoundaryRecovery();
          skippedStuckToken = true;
          this.toolbar?.setStatus?.("Skipping stuck word…");
        } else {
          this.toolbar?.setStatus?.("Retrying current word…");
        }

        this.activeBatchRequest = null;
        root.setTimeout(() => {
          if (
            requestSerial !== this.batchRequestSerial ||
            this.stopped ||
            this.paused
          ) {
            return;
          }
          if (skippedStuckToken) {
            console.warn("Edge Natural TTS advanced one token to escape a no-boundary loop.");
          }
          this.speakCurrentPosition();
        }, BATCH_RETRY_DELAY_MS);
      }, BATCH_START_TIMEOUT_MS);
    }

    handleSpeechStart(latencyMs) {
      const request = this.activeBatchRequest;
      if (request?.serial === this.batchRequestSerial) {
        request.audioStarted = true;
      }

      // If Chromium produces audio but never emits boundary events, there would
      // otherwise be no visual feedback at all. Highlight the committed cursor
      // at audio start; real boundaries take over immediately when available.
      const block = this.model?.blocks?.[this.currentBlockIndex];
      const segment = block?.segments?.[this.currentSegmentIndex];
      if (block && segment) {
        this.highlighter?.highlight?.(block, segment);
      }

      return super.handleSpeechStart(latencyMs);
    }

    handleBoundary(segment) {
      this.clearBatchStartWatchdog();
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      return super.handleBoundary(segment);
    }

    handleBlockEnd() {
      this.clearBatchStartWatchdog();
      this.activeBatchRequest = null;
      this.resetNoBoundaryRecovery();
      if (this.stopped || !this.model) {
        return;
      }

      const nextBlockIndex = nextBatchBlockIndex(
        this.activeBatchEndBlockIndex,
        this.currentBlockIndex
      );

      this.activeBatchEndBlockIndex = -1;
      this.currentBlockIndex = nextBlockIndex;
      this.currentSegmentIndex = 0;

      if (this.currentBlockIndex >= this.model.blocks.length) {
        this.finishDocument();
        return;
      }

      // Do not start the next SpeechSynthesis session re-entrantly from inside
      // the previous utterance's `end` callback. Commit the next cursor now,
      // then start it on a fresh browser task after Chromium has unwound `end`.
      this.toolbar?.setStatus?.("Loading next batch…");
      this.batchRequestSerial += 1;
      this.clearBatchTransitionTimer();
      this.batchTransitionTimer = root.setTimeout(() => {
        this.batchTransitionTimer = null;
        if (this.stopped || this.paused || !this.model) {
          return;
        }
        this.speakCurrentPosition();
      }, BATCH_TRANSITION_DELAY_MS);
    }
  }

  return {
    ReliableReaderApp,
    BATCH_TRANSITION_DELAY_MS,
    BATCH_START_TIMEOUT_MS,
    MAX_AUDIO_NO_BOUNDARY_RETRIES,
    advanceCursorOneSegment,
    cursorKey,
    nextBatchBlockIndex
  };
});
