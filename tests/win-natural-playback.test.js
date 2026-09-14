const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readerSource = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");

function loadStack() {
  global.EdgeTtsExtension = {};
  global.speechSynthesis = {
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    cancel() {}
  };
  const messages = [];
  let resolveNative;
  const audio = {
    paused: true,
    src: "",
    onended: null,
    onerror: null,
    playCalls: 0,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
    load() {},
    removeAttribute() { this.src = ""; }
  };
  global.document = { createElement: () => audio };
  global.URL = {
    createObjectURL: () => "blob:native-test",
    revokeObjectURL: (value) => { revoked.push(value); }
  };
  global.Blob = class BlobMock {};
  global.chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(message);
        if (message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE") {
          return new Promise((resolve) => { resolveNative = resolve; });
        }
        if (message.type === "EDGE_TTS_LOCAL_SPEAK") return Promise.resolve({ accepted: true });
        return Promise.resolve({ voices: [] });
      }
    }
  };
  const revoked = [];
  const speechApi = require("../src/content/speech-engine.js");
  require("../src/content/reliable-speech-engine.js");
  require("../src/content/direct-audio-engine.js");
  const { LocalTtsSpeechEngine, nativeVoiceToCatalogVoice } = require("../src/content/local-tts-engine.js");
  return {
    LocalTtsSpeechEngine,
    nativeVoiceToCatalogVoice,
    speechApi,
    audio,
    messages,
    revoked,
    resolveNative: (value) => resolveNative(value)
  };
}

function nativeVoice(api) {
  return api.nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
}

function waitForTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ReaderApp prepares only WIN-NATURAL during changeVoice before persistence", () => {
  const changeVoiceStart = readerSource.indexOf("    async changeVoice(selectionKey)");
  const changeVoiceEnd = readerSource.indexOf("    async changeRate", changeVoiceStart);
  const changeVoice = readerSource.slice(changeVoiceStart, changeVoiceEnd);
  const nativeCondition = changeVoice.indexOf('voice.__edgeTtsSource === "win-natural"');
  const prepare = changeVoice.indexOf("this.speech.prepareDirectPlayback?.(voice)");
  const save = changeVoice.indexOf("await this.saveSettings()");
  assert.ok(nativeCondition >= 0);
  assert.ok(prepare > nativeCondition);
  assert.ok(save > prepare);
  assert.equal((changeVoice.match(/prepareDirectPlayback/g) || []).length, 1);
  assert.equal(changeVoice.includes("isDirectVoice"), false);
});

test("normal-reader native routing remains isolated from other voice routes", () => {
  const localSource = fs.readFileSync(path.join(__dirname, "..", "src", "content", "local-tts-engine.js"), "utf8");
  assert.doesNotMatch(localSource, /traceWinNatural/);
  assert.match(localSource, /if \(!isWinNaturalVoice\(voice\)\)/);
});

test("native reader accepts the large flattened response payload returned by background synthesis", () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  const totalBytes = 5537520;
  const wavBase64 = Buffer.alloc(totalBytes, 0x52).toString("base64");
  const response = { accepted: true, wavBase64, totalBytes };

  assert.equal(response.accepted, true);
  assert.equal(response.wavBase64.length, 7383360);
  assert.equal(engine._nativeBytesFromBase64(response.wavBase64).length, totalBytes);
  assert.throws(() => engine._nativeBytesFromBase64("not-base64"), /invalid WAV data/);
});

test("native reader preserves validated timing metadata without driving playback from it", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  const voice = nativeVoice(api);
  engine.speak({ segments: [{ text: "hello native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice });
  await waitForTurn();
  api.resolveNative({
    accepted: true,
    wavBase64: Buffer.from("wav").toString("base64"),
    totalBytes: 3,
    timing: [
      { charIndex: 0, charLength: 5, audioMs: 0 },
      { charIndex: 99, charLength: 2, audioMs: 20 },
      { charIndex: 7, charLength: 6, audioMs: 12 }
    ]
  });
  await waitForTurn();
  await waitForTurn();
  assert.deepEqual(engine.winNaturalTiming, [{ charIndex: 0, charLength: 5, audioMs: 0 }]);
  assert.equal(api.audio.playCalls, 1);
});

test("engine preparation does not invoke the native unlock path for Online or Legacy voices", () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  let nativePreparationCalls = 0;
  const original = engine._ensureWinNaturalAudio.bind(engine);
  engine._ensureWinNaturalAudio = () => {
    nativePreparationCalls += 1;
    return original();
  };
  assert.equal(engine.prepareDirectPlayback({ name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true }), true);
  assert.equal(engine.prepareDirectPlayback({ name: "Microsoft Zira", lang: "en-US", localService: true }), false);
  assert.equal(nativePreparationCalls, 0);
});

test("stacked LocalTtsSpeechEngine routes native Aria through background with the exact token", async () => {
  const api = loadStack();
  const started = [];
  const ended = [];
  const engine = new api.LocalTtsSpeechEngine({
    onStart: (segment) => started.push(segment),
    onEnd: () => ended.push(true)
  });
  const voice = nativeVoice(api);

  assert.equal(engine.prepareDirectPlayback(voice), true);
  assert.equal(engine.directAudio, null, "native preparation must not touch the Online audio element");

  engine.speak({ segments: [{ text: "hello native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice });
  await waitForTurn();
  const request = api.messages.find((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE");
  assert.equal(request.voiceId, "Local-NarratorVoices");
  assert.equal(api.messages.some((message) => message.type === "EDGE_TTS_LOCAL_SPEAK"), false);

  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(engine.winNaturalSessionMode, true);
  assert.equal(engine.winNaturalActive, true);
  assert.equal(started.length, 1);
  api.audio.onended();
  assert.equal(ended.length, 1);
  assert.equal(api.revoked.length, 1);
  await waitForTurn();
  assert.equal(api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE").length, 1);
});

test("Stop invalidates a pending native response and does not start late audio", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [{ text: "late native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  engine.cancel();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  assert.equal(api.audio.playCalls, 0);
  assert.equal(api.revoked.length, 0);
});

test("native Pause/abandon silence audio and revoke the active object URL", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [{ text: "active native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  engine.pause();
  assert.equal(api.audio.paused, true);
  assert.equal(api.revoked.length, 1);

  engine.speak({ segments: [{ text: "quit native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  engine.abandon();
  assert.equal(api.audio.paused, true);
  assert.equal(api.revoked.length, 2);
});

test("switching native to legacy clears native audio before Chrome TTS routing", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [{ text: "native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  engine.speak({ segments: [{ text: "legacy", blockIndex: 0, segmentIndex: 0 }] }, 0, {
    voice: { name: "Microsoft Zira", lang: "en-US", localService: true, __edgeTtsSource: "chrome-tts", chromeVoiceName: "Microsoft Zira" }
  });
  assert.equal(engine.winNaturalSessionMode, false);
  assert.equal(api.audio.paused, true);
  assert.equal(api.messages.at(-1).type, "EDGE_TTS_LOCAL_SPEAK");
});

test("switching to Online remains on the existing direct backend", () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [{ text: "online", blockIndex: 0, segmentIndex: 0 }] }, 0, {
    voice: { name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true }
  });
  assert.equal(engine.winNaturalSessionMode, false);
  assert.equal(engine.directSessionMode, true);
});
