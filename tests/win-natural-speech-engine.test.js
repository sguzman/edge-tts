const test = require("node:test");
const assert = require("node:assert/strict");

class MockBaseEngine {
  constructor(options = {}) {
    this.onStart = options.onStart;
    this.onEnd = options.onEnd;
    this.onError = options.onError;
    this.generation = 0;
    this.delegated = [];
  }

  speak(_block, _start, options) {
    this.delegated.push(options.voice);
  }

  cancel() { this.baseCancelled = true; }
  abandon() { this.baseAbandoned = true; }
  pause() { this.basePaused = true; }
  resume() { this.baseResumed = true; }
  isPaused() { return false; }
  isSpeaking() { return false; }
  prepareDirectPlayback() { this.basePrepared = true; return true; }
}

global.EdgeTtsExtension = {
  SpeechEngine: { SpeechEngine: MockBaseEngine },
  LocalTts: { isWinNaturalVoice: (voice) => voice?.__edgeTtsSource === "win-natural" }
};

let sendMessage;
global.chrome = { runtime: { sendMessage: (...args) => sendMessage(...args) } };
global.performance = { now: () => 10 };

const { WinNaturalSpeechEngine, textForSegments } = require("../src/content/win-natural-speech-engine.js");

const nativeVoice = {
  name: "Microsoft Aria",
  lang: "en-US",
  __edgeTtsSource: "win-natural",
  nativeVoiceId: "Local-NarratorVoices"
};
const onlineVoice = { name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true };
const legacyVoice = { name: "Microsoft Zira", lang: "en-US", localService: true };
const block = { segments: [{ text: "hello", blockIndex: 0, segmentIndex: 0 }] };

test("Windows Natural intercepts only the native voice and preserves the actual token ID", async () => {
  let request;
  sendMessage = (message) => {
    request = message;
    return Promise.resolve({ accepted: false, error: "test stop" });
  };
  const errors = [];
  const engine = new WinNaturalSpeechEngine({ onError: (error) => errors.push(error.message) });
  engine.speak(block, 0, { voice: nativeVoice });
  await Promise.resolve();
  assert.equal(request.type, "EDGE_TTS_WIN_NATURAL_SYNTHESIZE");
  assert.equal(request.voiceId, "Local-NarratorVoices");
  assert.deepEqual(errors, ["test stop"]);
});

test("Online and Windows Legacy voices delegate unchanged", () => {
  sendMessage = () => Promise.resolve({ accepted: false });
  const engine = new WinNaturalSpeechEngine({});
  engine.speak(block, 0, { voice: onlineVoice });
  engine.speak(block, 0, { voice: legacyVoice });
  assert.deepEqual(engine.delegated, [onlineVoice, legacyVoice]);
});

test("missing or non-Local native token fails closed", () => {
  sendMessage = () => Promise.resolve({ accepted: true });
  const errors = [];
  const engine = new WinNaturalSpeechEngine({ onError: (error) => errors.push(error.message) });
  engine.speak(block, 0, {
    voice: { ...nativeVoice, nativeVoiceId: "Edge-Aria" }
  });
  engine.speak(block, 0, {
    voice: { ...nativeVoice, nativeVoiceId: "" }
  });
  assert.deepEqual(errors, [
    "Windows Natural voice has no valid Local-* SAPI token.",
    "Windows Natural voice has no valid Local-* SAPI token."
  ]);
});

test("native text preserves segment and paragraph separators", () => {
  assert.equal(
    textForSegments([
      { text: "one", blockIndex: 0 },
      { text: "two", blockIndex: 0 },
      { text: "three", blockIndex: 1 }
    ]),
    "one two\n\nthree"
  );
});

test("Stop invalidates a late native synthesis response", async () => {
  let resolveRequest;
  sendMessage = () => new Promise((resolve) => { resolveRequest = resolve; });
  let starts = 0;
  const engine = new WinNaturalSpeechEngine({ onStart: () => { starts += 1; } });
  engine.speak(block, 0, { voice: nativeVoice });
  engine.cancel();
  resolveRequest({ accepted: true, wavBase64: Buffer.from("wav").toString("base64") });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 0);
  assert.equal(engine.nativeSessionMode, false);
});

test("switching to another backend invalidates stale native audio", async () => {
  let resolveRequest;
  sendMessage = () => new Promise((resolve) => { resolveRequest = resolve; });
  const engine = new WinNaturalSpeechEngine({});
  engine.speak(block, 0, { voice: nativeVoice });
  engine.speak(block, 0, { voice: onlineVoice });
  resolveRequest({ accepted: true, wavBase64: Buffer.from("wav").toString("base64") });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(engine.delegated, [onlineVoice]);
  assert.equal(engine.nativeSessionMode, false);
});

test("abandon invalidates a late native synthesis response", async () => {
  let resolveRequest;
  sendMessage = () => new Promise((resolve) => { resolveRequest = resolve; });
  let starts = 0;
  const engine = new WinNaturalSpeechEngine({ onStart: () => { starts += 1; } });
  engine.speak(block, 0, { voice: nativeVoice });
  engine.abandon();
  resolveRequest({ accepted: true, wavBase64: Buffer.from("wav").toString("base64") });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 0);
  assert.equal(engine.nativeSessionMode, false);
});

test("gesture preparation is native-only and delegates Online preparation", () => {
  global.document = {
    createElement: () => ({
      muted: false,
      src: "",
      load() {},
      pause() {},
      play() { return Promise.resolve(); },
      removeAttribute() {}
    })
  };
  sendMessage = () => Promise.resolve({ accepted: false });
  const engine = new WinNaturalSpeechEngine({});
  assert.equal(engine.prepareDirectPlayback(nativeVoice), true);
  assert.equal(engine.basePrepared, undefined);
  assert.equal(engine.prepareDirectPlayback(onlineVoice), true);
  assert.equal(engine.basePrepared, true);
});

test("native audio URL is revoked after playback ends", async () => {
  const revoked = [];
  global.URL = {
    createObjectURL: () => "blob:native-test",
    revokeObjectURL: (url) => revoked.push(url)
  };
  global.Blob = class BlobMock {};
  global.document = {
    createElement: () => ({
      paused: true,
      load() {},
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}
    })
  };
  sendMessage = () => Promise.resolve({
    accepted: true,
    wavBase64: Buffer.from("wav").toString("base64")
  });
  let ended = 0;
  const engine = new WinNaturalSpeechEngine({ onEnd: () => { ended += 1; } });
  engine.speak(block, 0, { voice: nativeVoice });
  await Promise.resolve();
  await Promise.resolve();
  engine.nativeAudio.onended();
  assert.deepEqual(revoked, ["blob:native-test"]);
  assert.equal(ended, 1);
});
