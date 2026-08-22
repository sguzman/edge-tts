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
    this.advancedAfterRecovery = false;
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
    this.attemptsAtRecovery = this.recoveryAttempts;
    this.boundaryIndexAtRecovery = this.currentChunkBoundaryIndex;
  }

  advanceChunkAfterRecovery() {
    this.advancedAfterRecovery = true;
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
  isInternallyIdle,
  prematureEndRecoveryPlan,
  recoveryKeyForCurrentSegment
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
  assert.equal(engine.provisionalBoundaryActive, true);
  assert.notEqual(engine.progressWatchdog, null);

  engine.clearPlaybackTimers();
});

test("second no-boundary failure at the same token forces the one-token escape", () => {
  const engine = new ReliableSpeechEngine();
  const first = { blockIndex: 2, segmentIndex: 11, text: "stuck" };

  engine.currentChunks = [{ segments: [first, { blockIndex: 2, segmentIndex: 12, text: "next" }] }];
  engine.currentChunkIndex = 0;
  engine.currentChunkBoundaryIndex = 0;
  engine.recoveryKey = recoveryKeyForCurrentSegment(engine);
  engine.recoveryAttempts = 1;
  engine.provisionalBoundaryActive = true;

  engine.recoverCurrentChunk("no-boundary-progress");

  assert.equal(engine.recoveredReason, "no-boundary-progress");
  assert.equal(engine.attemptsAtRecovery, Number.MAX_SAFE_INTEGER);
  assert.equal(engine.provisionalBoundaryActive, false);
});

test("premature end with only one unreported tail token is treated as complete", () => {
  assert.deepEqual(prematureEndRecoveryPlan(3, 5), {
    action: "complete",
    restartIndex: -1
  });

  const engine = new ReliableSpeechEngine();
  engine.currentChunks = [{
    segments: ["a", "b", "c", "last-confirmed", "tail"].map((text, index) => ({
      blockIndex: 1,
      segmentIndex: index,
      text
    }))
  }];
  engine.currentChunkIndex = 0;
  engine.currentChunkBoundaryIndex = 3;

  engine.recoverCurrentChunk("premature-end");

  assert.equal(engine.advancedAfterRecovery, true);
  assert.equal(engine.recoveredReason, undefined);
});

test("early premature end resumes after the confirmed token instead of replaying it", () => {
  assert.deepEqual(prematureEndRecoveryPlan(1, 6), {
    action: "resume",
    restartIndex: 2
  });

  const engine = new ReliableSpeechEngine();
  engine.currentChunks = [{
    segments: Array.from({ length: 6 }, (_, index) => ({
      blockIndex: 3,
      segmentIndex: index,
      text: `word-${index}`
    }))
  }];
  engine.currentChunkIndex = 0;
  engine.currentChunkBoundaryIndex = 1;

  engine.recoverCurrentChunk("premature-end");

  assert.equal(engine.recoveredReason, "premature-end");
  assert.equal(engine.boundaryIndexAtRecovery, 2);
});
