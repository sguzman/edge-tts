const test = require("node:test");
const assert = require("node:assert/strict");

class BaseSpeechEngine {
  constructor() {
    this.currentUtterance = null;
    this.currentChunks = [];
    this.currentChunkIndex = -1;
    this.currentChunkBoundaryIndex = -1;
    this.currentOptions = null;
    this.generation = 0;
    this.recoveryKey = "";
    this.recoveryAttempts = 0;
    this.browserCancelCalls = 0;
    this.timersCleared = 0;
    this.heartbeatStarts = 0;
    this.progressWatchdog = null;
    this.heartbeatTimer = null;
    this.synth = { paused: false };
    this.onBoundary = null;
  }

  clearPlaybackTimers() {
    this.timersCleared += 1;
    if (this.progressWatchdog !== null) {
      clearTimeout(this.progressWatchdog);
      this.progressWatchdog = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startHeartbeat() {
    this.heartbeatStarts += 1;
  }

  recoverCurrentChunk(reason) {
    this.recoveredReason = reason;
  }

  cancel() {
    this.clearPlaybackTimers();
    this.browserCancelCalls += 1;
    this.generation += 1;
    this.currentUtterance = null;
    this.currentChunks = [];
    this.currentChunkIndex = -1;
    this.currentChunkBoundaryIndex = -1;
    this.currentOptions = null;
  }
}

global.EdgeTtsExtension = { SpeechEngine: { SpeechEngine: BaseSpeechEngine } };
const {
  ReliableSpeechEngine,
  isInternallyIdle
} = require("../src/content/reliable-speech-engine.js");

test("completed batch is internally idle even if currentUtterance is stale", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentUtterance = { stale: true };

  assert.equal(isInternallyIdle(engine), true);
});

test("clean batch handoff does not globally cancel speech synthesis", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentUtterance = { stale: true };

  engine.cancel();

  assert.equal(engine.browserCancelCalls, 0);
  assert.equal(engine.currentUtterance, null);
  assert.equal(engine.generation, 1);
});

test("active speech still uses the base cancel path", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentUtterance = { active: true };
  engine.currentChunks = [{ text: "still speaking" }];
  engine.currentChunkIndex = 0;
  engine.currentOptions = { rate: 1 };

  engine.cancel();

  assert.equal(engine.browserCancelCalls, 1);
  assert.equal(engine.currentUtterance, null);
});

test("utterance start provisionally commits the first token before real boundaries", () => {
  const engine = new ReliableSpeechEngine();
  const first = { blockIndex: 4, segmentIndex: 7, text: "broken" };
  let emitted = null;

  engine.currentUtterance = { active: true };
  engine.currentChunks = [{ segments: [first, { blockIndex: 4, segmentIndex: 8, text: "line" }] }];
  engine.currentChunkIndex = 0;
  engine.currentChunkBoundaryIndex = -1;
  engine.currentOptions = { rate: 1, stallTimeoutMs: 3000 };
  engine.generation = 5;
  engine.onBoundary = (segment, event) => {
    emitted = { segment, event };
  };

  engine.startHeartbeat(5);

  assert.equal(engine.heartbeatStarts, 1);
  assert.equal(engine.currentChunkBoundaryIndex, 0);
  assert.equal(emitted.segment, first);
  assert.equal(emitted.event.synthetic, true);
  assert.notEqual(engine.progressWatchdog, null);

  engine.clearPlaybackTimers();
});
