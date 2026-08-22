const test = require("node:test");
const assert = require("node:assert/strict");

class BaseReaderApp {
  constructor() {
    this.model = {
      blocks: Array.from({ length: 6 }, (_, index) => ({
        index,
        segments: [
          { blockIndex: index, segmentIndex: 0, text: `b${index}-zero` },
          { blockIndex: index, segmentIndex: 1, text: `b${index}-one` },
          { blockIndex: index, segmentIndex: 2, text: `b${index}-two` }
        ]
      }))
    };
    this.currentBlockIndex = 1;
    this.currentSegmentIndex = 1;
    this.activeBatchEndBlockIndex = 3;
    this.boundarySerial = 0;
    this.stopped = false;
    this.paused = false;
    this.baseSpeakCalls = 0;
    this.finished = false;
    this.status = "";
    this.highlighted = null;
    this.toolbar = { setStatus: (status) => (this.status = status) };
    this.highlighter = {
      highlight: (_block, segment) => {
        this.highlighted = segment;
      }
    };
    this.speech = { cancel: () => {} };
  }

  speakCurrentPosition() {
    this.baseSpeakCalls += 1;
  }

  handleSpeechStart() {}

  handleBoundary() {
    this.boundarySerial += 1;
  }

  stop() {
    this.stopped = true;
  }

  refreshText() {}

  finishDocument() {
    this.finished = true;
    this.stopped = true;
  }

  handleError() {
    this.stopped = true;
  }
}

global.EdgeTtsExtension = { Reader: { ReaderApp: BaseReaderApp } };
const {
  ReliableReaderApp,
  BATCH_TRANSITION_DELAY_MS,
  advanceCursorOneSegment,
  cursorKey,
  nextBatchBlockIndex
} = require("../src/content/reliable-reader.js");

test("next batch starts after the completed batch end, not the last boundary cursor", () => {
  assert.equal(nextBatchBlockIndex(3, 2), 4);
  assert.equal(nextBatchBlockIndex(-1, 2), 3);
});

test("one-token recovery advances monotonically within and across blocks", () => {
  const app = new BaseReaderApp();

  assert.deepEqual(advanceCursorOneSegment(app.model, 1, 1), {
    blockIndex: 1,
    segmentIndex: 2
  });
  assert.deepEqual(advanceCursorOneSegment(app.model, 1, 2), {
    blockIndex: 2,
    segmentIndex: 0
  });
  assert.equal(advanceCursorOneSegment(app.model, 5, 2), null);
  assert.equal(cursorKey(4, 7), "4:7");
});

test("audio start highlights the committed cursor even without boundary events", () => {
  const app = new ReliableReaderApp();
  app.batchRequestSerial = 9;
  app.activeBatchRequest = {
    serial: 9,
    cursor: { blockIndex: 1, segmentIndex: 1 },
    audioStarted: false
  };

  app.handleSpeechStart(42);

  assert.equal(app.activeBatchRequest.audioStarted, true);
  assert.equal(app.highlighted.text, "b1-one");
});

test("completed batch schedules the next batch on a fresh task", async () => {
  const app = new ReliableReaderApp();

  app.handleBlockEnd();

  assert.equal(app.currentBlockIndex, 4);
  assert.equal(app.currentSegmentIndex, 0);
  assert.equal(app.baseSpeakCalls, 0);
  assert.equal(app.status, "Loading next batch…");

  await new Promise((resolve) => setTimeout(resolve, BATCH_TRANSITION_DELAY_MS + 30));

  assert.equal(app.baseSpeakCalls, 1);
  app.stop();
});

test("final batch finishes the document instead of scheduling another batch", () => {
  const app = new ReliableReaderApp();
  app.currentBlockIndex = 5;
  app.activeBatchEndBlockIndex = 5;

  app.handleBlockEnd();

  assert.equal(app.finished, true);
  assert.equal(app.baseSpeakCalls, 0);
});
