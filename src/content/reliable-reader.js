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

  function nextBatchBlockIndex(activeBatchEndBlockIndex, currentBlockIndex) {
    const completedEndBlock =
      Number.isInteger(activeBatchEndBlockIndex) && activeBatchEndBlockIndex >= 0
        ? activeBatchEndBlockIndex
        : currentBlockIndex;
    return completedEndBlock + 1;
  }

  if (!BaseReaderApp) {
    return {
      ReliableReaderApp: null,
      BATCH_TRANSITION_DELAY_MS,
      BATCH_START_TIMEOUT_MS,
      nextBatchBlockIndex
    };
  }

  class ReliableReaderApp extends BaseReaderApp {
    constructor() {
      super();
      this.batchTransitionTimer = null;
      this.batchStartWatchdog = null;
      this.batchRequestSerial = 0;
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

    stop() {
      this.batchRequestSerial += 1;
      this.clearReliabilityTimers();
      return super.stop();
    }

    refreshText() {
      this.batchRequestSerial += 1;
      this.clearReliabilityTimers();
      return super.refreshText();
    }

    finishDocument() {
      this.batchRequestSerial += 1;
      this.clearReliabilityTimers();
      return super.finishDocument();
    }

    handleError(error) {
      this.batchRequestSerial += 1;
      this.clearReliabilityTimers();
      return super.handleError(error);
    }

    speakCurrentPosition() {
      this.clearBatchTransitionTimer();
      this.clearBatchStartWatchdog();

      const requestSerial = ++this.batchRequestSerial;
      const boundarySerialBeforeRequest = this.boundarySerial;
      super.speakCurrentPosition();

      if (this.stopped || this.paused) {
        return;
      }

      // A Chromium/Edge online voice can occasionally accept speak() but never
      // produce start/boundary/end/error events for the new utterance. Never
      // let that silently strand the reader at a batch boundary. If no word
      // boundary appears, cancel the wedged request and retry from the same
      // model cursor after the speech engine has had time to settle.
      this.batchStartWatchdog = root.setTimeout(() => {
        this.batchStartWatchdog = null;
        if (
          requestSerial !== this.batchRequestSerial ||
          this.stopped ||
          this.paused ||
          this.boundarySerial !== boundarySerialBeforeRequest
        ) {
          return;
        }

        console.warn(
          "Edge Natural TTS next batch produced no progress; resetting speech and retrying."
        );
        this.toolbar?.setStatus?.("Retrying next batch…");
        this.speech?.cancel?.();

        root.setTimeout(() => {
          if (
            requestSerial !== this.batchRequestSerial ||
            this.stopped ||
            this.paused
          ) {
            return;
          }
          this.speakCurrentPosition();
        }, BATCH_RETRY_DELAY_MS);
      }, BATCH_START_TIMEOUT_MS);
    }

    handleBoundary(segment) {
      this.clearBatchStartWatchdog();
      return super.handleBoundary(segment);
    }

    handleBlockEnd() {
      this.clearBatchStartWatchdog();
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
      // the previous utterance's `end` callback. The base SpeechEngine begins a
      // new session by canceling/resetting the old one, and doing that while
      // Chromium is still unwinding `end` can wedge online Natural voices.
      // Commit the next cursor now, then start it on a fresh browser task.
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
    nextBatchBlockIndex
  };
});
