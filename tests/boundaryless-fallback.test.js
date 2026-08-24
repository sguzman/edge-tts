const test = require("node:test");
const assert = require("node:assert/strict");

class MockSpeechEngine {
  constructor() {
    this.currentChunks = [{
      segments: [
        { blockIndex: 0, segmentIndex: 0, text: "code" },
        { blockIndex: 0, segmentIndex: 1, text: "line" },
        { blockIndex: 0, segmentIndex: 2, text: "two" }
      ]
    }];
    this.currentChunkIndex = 0;
    this.provisionalBoundaryActive = true;
    this.recoveryKey = "stale";
    this.recoveryAttempts = 2;
    this.advanceCalls = 0;
    this.originalRecoveryReason = null;
    this.originalStartCalls = 0;
    this.originalSpeakCalls = 0;
  }

  speakCurrentChunk() {
    this.originalSpeakCalls += 1;
  }

  startHeartbeat() {
    this.originalStartCalls += 1;
  }

  recoverCurrentChunk(reason) {
    this.originalRecoveryReason = reason;
  }

  advanceChunkAfterRecovery() {
    this.advanceCalls += 1;
  }
}

class MockReaderApp {
  constructor() {
    this.speech = new MockSpeechEngine();
    this.model = {
      blocks: [{
        segments: this.speech.currentChunks[0].segments,
        sentences: []
      }]
    };
    this.settings = { rate: 1 };
    this.stopped = false;
    this.paused = false;
    this.highlights = [];
    this.highlighter = {
      highlight: (_block, segment) => this.highlights.push(segment.segmentIndex)
    };
    this.boundaryCalls = 0;
    this.speakCalls = 0;
  }

  handleBoundary() {
    this.boundaryCalls += 1;
  }

  speakCurrentPosition() {
    this.speakCalls += 1;
  }

  stop() {
    this.stopped = true;
  }

  handleBlockEnd() {}
  finishDocument() {}
  handleError() {}
  refreshText() {}
}

global.EdgeTtsExtension = {
  SpeechEngine: { SpeechEngine: MockSpeechEngine },
  Reader: { ReaderApp: MockReaderApp }
};

const {
  VISUAL_FALLBACK_DELAY_MS,
  visualStepMs
} = require("../src/content/boundaryless-fallback.js");

test("started boundaryless utterance completes instead of replaying", () => {
  const engine = new MockSpeechEngine();

  engine.speakCurrentChunk(1);
  assert.equal(engine.__edgeTtsTransportStarted, false);

  engine.startHeartbeat(1);
  assert.equal(engine.__edgeTtsTransportStarted, true);

  engine.recoverCurrentChunk("premature-end");

  assert.equal(engine.advanceCalls, 1);
  assert.equal(engine.originalRecoveryReason, null);
  assert.equal(engine.recoveryKey, "");
  assert.equal(engine.recoveryAttempts, 0);
});

test("never-started boundaryless utterance still delegates to recovery", () => {
  const engine = new MockSpeechEngine();

  engine.speakCurrentChunk(1);
  engine.recoverCurrentChunk("premature-end");

  assert.equal(engine.advanceCalls, 0);
  assert.equal(engine.originalRecoveryReason, "premature-end");
});

test("real boundary cancels visual approximation", async () => {
  const app = new MockReaderApp();
  app.speech.provisionalBoundaryActive = true;
  app.handleBoundary(app.speech.currentChunks[0].segments[0]);

  assert.equal(app.boundaryCalls, 1);

  app.speech.provisionalBoundaryActive = false;
  app.handleBoundary(app.speech.currentChunks[0].segments[1]);

  await new Promise((resolve) => setTimeout(resolve, VISUAL_FALLBACK_DELAY_MS + 60));
  assert.deepEqual(app.highlights, []);
});

test("boundaryless visual fallback advances highlighting without moving reader state", async () => {
  const app = new MockReaderApp();
  app.speech.provisionalBoundaryActive = true;
  app.handleBoundary(app.speech.currentChunks[0].segments[0]);

  await new Promise((resolve) => setTimeout(resolve, VISUAL_FALLBACK_DELAY_MS + 40));

  assert.deepEqual(app.highlights, [1]);
  assert.equal(app.boundaryCalls, 1, "approximation must not fabricate committed boundaries");
  app.stop();
});

test("visual step timing is bounded and rate-sensitive", () => {
  const normal = visualStepMs({ text: "identifier" }, 1);
  const fast = visualStepMs({ text: "identifier" }, 2);
  assert.ok(normal >= 140 && normal <= 650);
  assert.ok(fast >= 140 && fast <= normal);
});
