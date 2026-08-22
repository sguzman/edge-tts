const test = require("node:test");
const assert = require("node:assert/strict");

class BaseReaderApp {
  constructor() {
    this.model = { blocks: Array.from({ length: 6 }, (_, index) => ({ index })) };
    this.currentBlockIndex = 1;
    this.currentSegmentIndex = 4;
    this.activeBatchEndBlockIndex = 3;
    this.boundarySerial = 0;
    this.stopped = false;
    this.paused = false;
    this.baseSpeakCalls = 0;
    this.finished = false;
    this.status = "";
    this.toolbar = { setStatus: (status) => (this.status = status) };
    this.speech = { cancel: () => {} };
  }

  speakCurrentPosition() {
    this.baseSpeakCalls += 1;
  }

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
  nextBatchBlockIndex
} = require("../src/content/reliable-reader.js");

test("next batch starts after the completed batch end, not the last boundary cursor", () => {
  assert.equal(nextBatchBlockIndex(3, 2), 4);
  assert.equal(nextBatchBlockIndex(-1, 2), 3);
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

test("final batch finishes the document instead of scheduling another batch", async () => {
  const app = new ReliableReaderApp();
  app.currentBlockIndex = 5;
  app.activeBatchEndBlockIndex = 5;

  app.handleBlockEnd();

  assert.equal(app.finished, true);
  assert.equal(app.baseSpeakCalls, 0);
});
