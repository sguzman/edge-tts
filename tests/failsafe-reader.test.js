const test = require("node:test");
const assert = require("node:assert/strict");

class BaseReaderApp {
  constructor() {
    this.model = {
      blocks: [
        { segments: [{ text: "a" }, { text: "b" }] },
        { segments: [{ text: "c" }] }
      ]
    };
    this.currentBlockIndex = 0;
    this.currentSegmentIndex = 0;
    this.activeBatchEndBlockIndex = 0;
    this.boundarySerial = 0;
    this.batchRequestSerial = 0;
    this.activeBatchRequest = {};
    this.stopped = false;
    this.paused = false;
    this.speakCalls = 0;
    this.cancelCalls = 0;
    this.status = "";
    this.speech = { cancel: () => (this.cancelCalls += 1) };
    this.toolbar = { setStatus: (status) => (this.status = status) };
  }

  speakCurrentPosition() {
    this.speakCalls += 1;
  }

  handleSpeechStart() {}

  handleBoundary(segment) {
    this.boundarySerial += 1;
    if (segment) {
      this.currentBlockIndex = segment.blockIndex;
      this.currentSegmentIndex = segment.segmentIndex;
    }
  }

  handleBlockEnd() {}

  playPause() {
    this.paused = !this.paused;
  }

  stop() {
    this.stopped = true;
  }

  refreshText() {}

  finishDocument() {
    this.stopped = true;
  }

  handleError() {
    this.stopped = true;
  }

  clearReliabilityTimers() {}
}

global.EdgeTtsExtension = { Reader: { ReaderApp: BaseReaderApp } };
const {
  FailSafeReaderApp,
  advanceCursorOneSegment,
  findFreshTerminalContinuation,
  isRecoverableReaderError,
  matchingSegmentPrefixLength
} = require("../src/content/failsafe-reader.js");

test("failsafe cursor advances within a block and across block boundaries", () => {
  const model = new BaseReaderApp().model;
  assert.deepEqual(advanceCursorOneSegment(model, 0, 0), {
    blockIndex: 0,
    segmentIndex: 1
  });
  assert.deepEqual(advanceCursorOneSegment(model, 0, 1), {
    blockIndex: 1,
    segmentIndex: 0
  });
  assert.equal(advanceCursorOneSegment(model, 1, 0), null);
});

test("speech transport failures are classified as recoverable reader errors", () => {
  assert.equal(isRecoverableReaderError(new Error("Speech synthesis failed: network")), true);
  assert.equal(isRecoverableReaderError(new Error("Speech synthesis failed: synthesis-failed")), true);
  assert.equal(isRecoverableReaderError(new Error("SpeechSynthesis is not available on this page.")), false);
});

test("terminal verification detects a block appended after the old ChatGPT snapshot", () => {
  const previous = {
    blocks: [
      {
        authorRole: "assistant",
        text: "old terminal paragraph",
        segments: [{ text: "old" }, { text: "terminal" }, { text: "paragraph" }]
      }
    ]
  };
  const fresh = {
    blocks: [
      previous.blocks[0],
      {
        authorRole: "assistant",
        text: "new paragraph",
        segments: [{ text: "new" }, { text: "paragraph" }]
      }
    ]
  };

  assert.deepEqual(findFreshTerminalContinuation(previous, fresh), {
    blockIndex: 1,
    segmentIndex: 0,
    reason: "appended-block"
  });
});

test("terminal verification resumes a final block that grew while streaming", () => {
  const previous = {
    blocks: [
      {
        authorRole: "assistant",
        text: "alpha beta",
        segments: [{ text: "alpha" }, { text: "beta" }]
      }
    ]
  };
  const fresh = {
    blocks: [
      {
        authorRole: "assistant",
        text: "alpha beta gamma delta",
        segments: [
          { text: "alpha" },
          { text: "beta" },
          { text: "gamma" },
          { text: "delta" }
        ]
      }
    ]
  };

  assert.equal(matchingSegmentPrefixLength(previous.blocks[0].segments, fresh.blocks[0].segments), 2);
  assert.deepEqual(findFreshTerminalContinuation(previous, fresh), {
    blockIndex: 0,
    segmentIndex: 2,
    reason: "grown-terminal-block"
  });
});

test("terminal verification accepts a truly unchanged document end", () => {
  const model = {
    blocks: [
      {
        authorRole: "assistant",
        text: "the actual end",
        segments: [{ text: "the" }, { text: "actual" }, { text: "end" }]
      }
    ]
  };
  assert.equal(findFreshTerminalContinuation(model, model), null);
});

test("liveness timeout cannot leave the reader on the same dead cursor", async () => {
  const app = new FailSafeReaderApp();
  app.playbackLivenessTimeoutMs = 100;
  app.failsafeRestartDelayMs = 10;
  app.armPlaybackLivenessWatchdog();

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(app.cancelCalls, 1);
  assert.equal(app.currentBlockIndex, 0);
  assert.equal(app.currentSegmentIndex, 1);
  assert.equal(app.speakCalls, 1);
  assert.equal(app.status, "Recovering playback…");

  app.stop();
});

test("fatal transport error auto-continues instead of marking reader stopped", async () => {
  const app = new FailSafeReaderApp();
  app.failsafeRestartDelayMs = 10;

  app.handleError(new Error("Speech synthesis failed: network"));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(app.stopped, false);
  assert.equal(app.cancelCalls, 1);
  assert.equal(app.currentBlockIndex, 0);
  assert.equal(app.currentSegmentIndex, 1);
  assert.equal(app.speakCalls, 1);
  assert.equal(app.status, "Recovering speech error…");

  app.stop();
});

test("real boundary progress rearms the failsafe instead of forcing recovery", async () => {
  const app = new FailSafeReaderApp();
  app.playbackLivenessTimeoutMs = 100;
  app.armPlaybackLivenessWatchdog();

  await new Promise((resolve) => setTimeout(resolve, 25));
  app.handleBoundary({ blockIndex: 0, segmentIndex: 1 });
  app.stop();

  assert.equal(app.cancelCalls, 0);
});
