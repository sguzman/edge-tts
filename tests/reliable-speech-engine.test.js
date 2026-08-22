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
  }

  clearPlaybackTimers() {
    this.timersCleared += 1;
  }

  cancel() {
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
