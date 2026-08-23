const test = require("node:test");
const assert = require("node:assert/strict");

class FakeUtterance {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
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
    this.browserCancelCalls = 0;
    this.timersCleared = 0;
    this.progressWatchdog = null;
    this.heartbeatTimer = null;
    this.synth = { paused: false };
    this.onBoundary = null;
    this.advancedAfterRecovery = false;
    this.lastSpeak = null;
  }

  speak(block, startSegmentIndex, options) {
    this.lastSpeak = { block, startSegmentIndex, options };
    return this.lastSpeak;
  }

  speakCurrentChunk(generation) {
    const utterance = new FakeUtterance();
    utterance.addEventListener("error", (event) => {
      if (generation !== this.generation) return;
      this.clearPlaybackTimers();
      this.currentUtterance = null;
      // Mirrors the old base dead branch: canceled/interrupted are swallowed.
      if (event.error !== "canceled" && event.error !== "interrupted") {
        this.recoverCurrentChunk(`error:${event.error}`);
      }
    });
    this.currentUtterance = utterance;
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
  REMOTE_VOICE_TARGET_CHARS,
  REMOTE_VOICE_HARD_MAX_CHARS,
  isInternallyIdle,
  isRemoteVoice,
  isSpontaneousRecoverableError,
  prematureEndRecoveryPlan,
  recoveryKeyForCurrentSegment,
  safeChunkOptionsForVoice
} = require("../src/content/reliable-speech-engine.js");

test("remote Natural voices are detected even when localService metadata is absent", () => {
  assert.equal(isRemoteVoice({ name: "Microsoft Aria Online (Natural)" }), true);
  assert.equal(isRemoteVoice({ name: "Some remote", localService: false }), true);
  assert.equal(isRemoteVoice({ name: "Microsoft David", localService: true }), false);
});

test("remote voices use coarse healthy transport instead of 175-character stutter chunks", () => {
  const safe = safeChunkOptionsForVoice(
    { name: "Microsoft Aria Online (Natural)", localService: false },
    { firstChunkMaxChars: 2400, maxChars: 2400, emergencyMaxChars: 8000 }
  );

  assert.equal(REMOTE_VOICE_TARGET_CHARS, 900);
  assert.equal(REMOTE_VOICE_HARD_MAX_CHARS, 1200);
  assert.equal(safe.firstChunkMaxChars, 900);
  assert.equal(safe.maxChars, 900);
  assert.equal(safe.emergencyMaxChars, 1200);
});

test("smaller caller transport requests are preserved", () => {
  const safe = safeChunkOptionsForVoice(
    { name: "Microsoft Aria Online (Natural)", localService: false },
    { firstChunkMaxChars: 700, maxChars: 800, emergencyMaxChars: 1000 }
  );

  assert.equal(safe.firstChunkMaxChars, 700);
  assert.equal(safe.maxChars, 800);
  assert.equal(safe.emergencyMaxChars, 1000);
});

test("local voices keep the requested transport chunk sizes", () => {
  const requested = { firstChunkMaxChars: 900, maxChars: 1800, emergencyMaxChars: 8000 };
  const safe = safeChunkOptionsForVoice(
    { name: "Microsoft David", localService: true },
    requested
  );

  assert.deepEqual(safe, requested);
});

test("ReliableSpeechEngine applies balanced remote sizing before delegating", () => {
  const engine = new ReliableSpeechEngine();
  const voice = { name: "Microsoft Aria Online (Natural)", localService: false };

  engine.speak({ segments: [{ text: "hello" }] }, 0, {
    voice,
    rate: 1,
    chunkOptions: { firstChunkMaxChars: 2400, maxChars: 2400, emergencyMaxChars: 8000 }
  });

  assert.equal(engine.lastSpeak.options.chunkOptions.firstChunkMaxChars, 900);
  assert.equal(engine.lastSpeak.options.chunkOptions.maxChars, 900);
  assert.equal(engine.lastSpeak.options.chunkOptions.emergencyMaxChars, 1200);
});

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

test("utterance start commits a provisional token without a periodic resume heartbeat", () => {
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

  assert.equal(engine.heartbeatTimer, null);
  assert.equal(engine.currentChunkBoundaryIndex, 0);
  assert.equal(emitted.segment, first);
  assert.equal(emitted.event.synthetic, true);
  assert.equal(engine.provisionalBoundaryActive, true);
  assert.notEqual(engine.progressWatchdog, null);

  engine.clearPlaybackTimers();
});

test("spontaneous canceled/interrupted errors are recoverable", () => {
  assert.equal(isSpontaneousRecoverableError("canceled"), true);
  assert.equal(isSpontaneousRecoverableError("interrupted"), true);
  assert.equal(isSpontaneousRecoverableError("network"), false);

  for (const error of ["canceled", "interrupted"]) {
    const engine = new ReliableSpeechEngine();
    engine.currentChunks = [{
      segments: [
        { blockIndex: 1, segmentIndex: 0, text: "keep" },
        { blockIndex: 1, segmentIndex: 1, text: "going" }
      ]
    }];
    engine.currentChunkIndex = 0;
    engine.currentChunkBoundaryIndex = 0;
    engine.currentOptions = { rate: 1 };
    engine.generation = 4;

    engine.speakCurrentChunk(4);
    const utterance = engine.currentUtterance;
    utterance.emit("error", { error });

    assert.equal(engine.recoveredReason, `error:${error}`);
  }
});

test("intentional cancel generation invalidates later interruption callbacks", () => {
  const engine = new ReliableSpeechEngine();
  engine.currentChunks = [{ segments: [{ blockIndex: 1, segmentIndex: 0, text: "old" }] }];
  engine.currentChunkIndex = 0;
  engine.currentOptions = { rate: 1 };
  engine.generation = 2;
  engine.speakCurrentChunk(2);
  const utterance = engine.currentUtterance;

  engine.generation = 3;
  utterance.emit("error", { error: "interrupted" });

  assert.equal(engine.recoveredReason, undefined);
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
