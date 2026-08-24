const test = require("node:test");
const assert = require("node:assert/strict");

class FakeUtterance {
  addEventListener() {}
}

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
    this.progressWatchdog = null;
    this.heartbeatTimer = null;
    this.synth = { paused: false };
  }

  speakCurrentChunk() {
    this.currentUtterance = new FakeUtterance();
  }

  recoverCurrentChunk(reason) {
    this.recoveredReason = reason;
    this.boundaryIndexAtRecovery = this.currentChunkBoundaryIndex;
  }

  clearPlaybackTimers() {}

  cancel() {}
}

global.EdgeTtsExtension = { SpeechEngine: { SpeechEngine: BaseSpeechEngine } };
const { ReliableSpeechEngine } = require("../src/content/reliable-speech-engine.js");

test("transport is provisional before Chromium receives the utterance", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentChunks = [{
    segments: [
      { blockIndex: 2, segmentIndex: 0, text: "first" },
      { blockIndex: 2, segmentIndex: 1, text: "second" }
    ]
  }];
  engine.currentChunkIndex = 0;
  engine.currentOptions = { rate: 1 };
  engine.generation = 4;

  engine.speakCurrentChunk(4);

  assert.equal(engine.currentChunkBoundaryIndex, 0);
  assert.equal(engine.provisionalBoundaryActive, true);
});

test("premature end with only provisional progress retries from the first token", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentChunks = [{
    segments: [
      { blockIndex: 3, segmentIndex: 0, text: "not" },
      { blockIndex: 3, segmentIndex: 1, text: "confirmed" },
      { blockIndex: 3, segmentIndex: 2, text: "yet" }
    ]
  }];
  engine.currentChunkIndex = 0;
  engine.currentChunkBoundaryIndex = 0;
  engine.provisionalBoundaryActive = true;

  engine.recoverCurrentChunk("premature-end");

  assert.equal(engine.recoveredReason, "end-without-confirmed-boundary");
  assert.equal(engine.boundaryIndexAtRecovery, -1);
  assert.equal(engine.provisionalBoundaryActive, false);
});
