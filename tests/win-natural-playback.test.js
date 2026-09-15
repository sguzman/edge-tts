const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readerSource = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");

function loadStack({ webAudio = false } = {}) {
  global.EdgeTtsExtension = {};
  global.EdgeTtsExtension.TextModel = require("../src/content/text-model.js");
  global.speechSynthesis = {
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    cancel() {}
  };
  const messages = [];
  let resolveNative;
  const frames = new Map();
  let frameId = 0;
  global.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  const audio = {
    paused: true,
    currentTime: 0,
    playbackRate: 1,
    volume: 1,
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
  const audioContexts = [];
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.sources = [];
      this.gains = [];
      audioContexts.push(this);
    }
    createMediaElementSource(element) {
      const source = { element, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      this.sources.push(source);
      return source;
    }
    createGain() {
      const gain = { gain: { value: 1 }, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      this.gains.push(gain);
      return gain;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
      this.closed = true;
      return Promise.resolve();
    }
  }
  if (webAudio) {
    global.AudioContext = FakeAudioContext;
    global.webkitAudioContext = undefined;
  }
  global.document = { createElement: () => audio };
  let objectUrlId = 0;
  global.URL = {
    createObjectURL: () => `blob:native-test-${++objectUrlId}`,
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
    audioContexts,
    frames,
    runFrame: (timestamp = 0) => {
      const callbacks = [...frames.entries()];
      for (const [id, callback] of callbacks) {
        if (frames.delete(id)) callback(timestamp);
      }
    },
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

test("native timing maps through payload starts, deduplicates segments, and follows media time", async () => {
  const api = loadStack();
  const boundaries = [];
  const engine = new api.LocalTtsSpeechEngine({ onBoundary: (segment, metadata) => boundaries.push({ segment, metadata }) });
  const voice = nativeVoice(api);
  const block = {
    segments: [
      { text: "one", blockIndex: 0, segmentIndex: 0, sentenceIndex: 0 },
      { text: "two", blockIndex: 0, segmentIndex: 1, sentenceIndex: 0 }
    ]
  };
  engine.speak(block, 0, { voice });
  await waitForTurn();
  api.resolveNative({
    accepted: true,
    wavBase64: Buffer.from("wav").toString("base64"),
    totalBytes: 3,
    timing: [
      { charIndex: 0, charLength: 1, audioMs: 100 },
      { charIndex: 1, charLength: 1, audioMs: 200 },
      { charIndex: 4, charLength: 3, audioMs: 300 }
    ]
  });
  await waitForTurn();
  await waitForTurn();

  api.runFrame();
  assert.equal(boundaries.length, 0, "no boundary may emit before its media timestamp");
  api.audio.currentTime = 0.15;
  api.runFrame();
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].segment.text, "one");
  assert.equal(boundaries[0].metadata.type, "win-natural-word");

  api.audio.currentTime = 0.25;
  api.runFrame();
  assert.equal(boundaries.length, 1, "duplicate timing records must not re-emit a segment");

  api.audio.currentTime = 0.35;
  api.runFrame();
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[1].segment.text, "two");
  assert.equal(api.frames.size, 1, "the media-clock scheduler remains active while audio plays");
});

test("native timing clock catches up to the latest boundary and stops on cancel", async () => {
  const api = loadStack();
  const boundaries = [];
  const engine = new api.LocalTtsSpeechEngine({ onBoundary: (segment) => boundaries.push(segment.text) });
  const voice = nativeVoice(api);
  engine.speak({ segments: [
    { text: "one", blockIndex: 0, segmentIndex: 0, sentenceIndex: 0 },
    { text: "two", blockIndex: 0, segmentIndex: 1, sentenceIndex: 0 },
    { text: "three", blockIndex: 0, segmentIndex: 2, sentenceIndex: 0 }
  ] }, 0, { voice });
  await waitForTurn();
  api.resolveNative({
    accepted: true,
    wavBase64: Buffer.from("wav").toString("base64"),
    totalBytes: 3,
    timing: [
      { charIndex: 0, charLength: 3, audioMs: 0 },
      { charIndex: 4, charLength: 3, audioMs: 100 },
      { charIndex: 8, charLength: 5, audioMs: 200 }
    ]
  });
  await waitForTurn();
  await waitForTurn();
  api.audio.currentTime = 0.3;
  api.runFrame();
  assert.deepEqual(boundaries, ["three"]);
  engine.cancel();
  api.audio.currentTime = 1;
  api.runFrame();
  assert.deepEqual(boundaries, ["three"]);
  assert.equal(api.frames.size, 0);
});

test("native playback rate changes live without restarting audio or its boundary cursor", async () => {
  const api = loadStack();
  const boundaries = [];
  const engine = new api.LocalTtsSpeechEngine({ onBoundary: (segment) => boundaries.push(segment.text) });
  engine.speak({ segments: [
    { text: "one", blockIndex: 0, segmentIndex: 0 },
    { text: "two", blockIndex: 0, segmentIndex: 1 }
  ] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({
    accepted: true,
    wavBase64: Buffer.from("wav").toString("base64"),
    totalBytes: 3,
    timing: [
      { charIndex: 0, charLength: 3, audioMs: 100 },
      { charIndex: 4, charLength: 3, audioMs: 200 }
    ]
  });
  await waitForTurn();
  await waitForTurn();
  api.audio.currentTime = 0.15;
  api.runFrame();
  const source = api.audio.src;
  const requestCount = api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE").length;
  assert.deepEqual(boundaries, ["one"]);
  assert.equal(engine.setPlaybackRate(2), true);
  assert.equal(api.audio.playbackRate, 2);
  assert.equal(api.audio.src, source);
  assert.equal(api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE").length, requestCount);
  api.audio.currentTime = 0.25;
  api.runFrame();
  assert.deepEqual(boundaries, ["one", "two"], "rate changes must not reset the boundary cursor");
});

test("native latency optimization uses a short first chunk and normal later chunks", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  const first = `${"a".repeat(119)}.`;
  const second = `${"b".repeat(899)}.`;
  const third = "c";
  engine.speak({ segments: [
    { text: first, blockIndex: 0, segmentIndex: 0 },
    { text: second, blockIndex: 0, segmentIndex: 1 },
    { text: third, blockIndex: 0, segmentIndex: 2 }
  ] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  let requests = api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text.length, 120);
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  requests = api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE");
  assert.equal(requests.length, 2, "the next chunk should be prefetched once the first is accepted");
  assert.equal(requests[1].text.length, 900);
});

test("native prefetch promotes the ready chunk without overlap and applies current controls", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [
    { text: `${"a".repeat(119)}.`, blockIndex: 0, segmentIndex: 0 },
    { text: `${"b".repeat(899)}.`, blockIndex: 0, segmentIndex: 1 }
  ] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("one").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  const audio = api.audio;
  const firstSrc = audio.src;
  engine.setPlaybackRate(1.8);
  engine.setOutputVolume(0.4);
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("two").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  assert.equal(engine.winNaturalPrefetch?.kind, "ready");
  const playCalls = audio.playCalls;
  audio.onended();
  await waitForTurn();
  await waitForTurn();
  assert.notEqual(audio.src, firstSrc);
  assert.equal(audio.playbackRate, 1.8);
  assert.equal(audio.volume, 0.4);
  assert.equal(audio.playCalls, playCalls + 1);
  assert.equal(api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE").length, 2);
});

test("native stop invalidates an in-flight prefetch and cannot start it later", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [
    { text: `${"a".repeat(119)}.`, blockIndex: 0, segmentIndex: 0 },
    { text: `${"b".repeat(899)}.`, blockIndex: 0, segmentIndex: 1 }
  ] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("one").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  const audio = api.audio;
  const playCalls = audio.playCalls;
  engine.cancel();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("late").toString("base64"), totalBytes: 4 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(audio.playCalls, playCalls);
  assert.equal(engine.winNaturalPrefetch, null);
  assert.equal(engine.winNaturalActive, false);
});

test("native playback rate persists across a native chunk transition", async () => {
  const api = loadStack();
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [
    { text: `${"one ".repeat(32)}.`, blockIndex: 0, segmentIndex: 0 },
    { text: `${"two ".repeat(32)}.`, blockIndex: 0, segmentIndex: 1 }
  ] }, 0, {
    voice: nativeVoice(api)
  });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(engine.setPlaybackRate(1.7), true);
  const audio = api.audio;
  audio.onended();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitForTurn();
  const requests = api.messages.filter((message) => message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE");
  assert.equal(requests.length, 2);
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(engine.winNaturalAudio, audio);
  assert.equal(audio.playbackRate, 1.7);
});

test("native output gain changes live, supports boost, and reuses one audio graph", async () => {
  const api = loadStack({ webAudio: true });
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [{ text: "native gain", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(api.audioContexts.length, 1);
  const gain = api.audioContexts[0].gains[0];
  const source = api.audio.src;
  assert.equal(engine.setOutputVolume(0), true);
  assert.equal(gain.gain.value, 0);
  assert.equal(engine.setOutputVolume(1), true);
  assert.equal(gain.gain.value, 1);
  assert.equal(engine.setOutputVolume(1.8), true);
  assert.equal(gain.gain.value, 1.8);
  assert.equal(api.audio.volume, 1);
  assert.equal(api.audio.src, source);
  assert.equal(api.audioContexts.length, 1);
});

test("native output gain persists across chunks and reset silences the persistent element", async () => {
  const api = loadStack({ webAudio: true });
  const engine = new api.LocalTtsSpeechEngine({});
  engine.speak({ segments: [
    { text: `${"one ".repeat(32)}.`, blockIndex: 0, segmentIndex: 0 },
    { text: `${"two ".repeat(32)}.`, blockIndex: 0, segmentIndex: 1 }
  ] }, 0, {
    voice: nativeVoice(api)
  });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  engine.setOutputVolume(1.6);
  const audio = api.audio;
  audio.onended();
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  assert.equal(api.audioContexts.length, 1);
  assert.equal(api.audioContexts[0].gains[0].gain.value, 1.6);
  engine.cancel();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, "");
  assert.equal(api.audioContexts.length, 1);
});

test("native dispose finalizes old resources while Stop keeps reusable state", async () => {
  const api = loadStack({ webAudio: true });
  const first = new api.LocalTtsSpeechEngine({});
  first.speak({ segments: [{ text: "first native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  api.resolveNative({ accepted: true, wavBase64: Buffer.from("wav").toString("base64"), totalBytes: 3 });
  await waitForTurn();
  await waitForTurn();
  const oldAudio = api.audio;
  const oldContext = api.audioContexts[0];
  const oldSource = oldContext.sources[0];
  const oldGain = oldContext.gains[0];
  first.cancel();
  assert.equal(first.winNaturalAudio, oldAudio, "Stop/cancel must preserve same-engine reusable audio");
  assert.equal(api.audioContexts.length, 1);

  first.speak({ segments: [{ text: "restart native", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: nativeVoice(api) });
  await waitForTurn();
  first.dispose();
  first.dispose();
  assert.equal(first.disposed, true);
  assert.equal(first.winNaturalAudio, null);
  assert.equal(oldAudio.paused, true);
  assert.equal(oldAudio.src, "");
  assert.equal(oldAudio.onended, null);
  assert.equal(oldAudio.onerror, null);
  assert.equal(oldContext.closed, true);
  assert.equal(oldSource.disconnected, true);
  assert.equal(oldGain.disconnected, true);
  assert.equal(api.frames.size, 0);

  const oldDocumentCreate = global.document.createElement;
  global.document.createElement = () => {
    const next = Object.assign({}, api.audio, {
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      volume: 1,
      src: "",
      onended: null,
      onerror: null
    });
    next.play = api.audio.play;
    next.pause = api.audio.pause;
    next.load = api.audio.load;
    next.removeAttribute = api.audio.removeAttribute;
    return next;
  };
  const second = new api.LocalTtsSpeechEngine({});
  assert.equal(second.prepareDirectPlayback(nativeVoice(api)), true);
  assert.notEqual(second.winNaturalAudio, oldAudio);
  assert.equal(api.audioContexts.length, 2);
  assert.notEqual(api.audioContexts[1], oldContext);
  global.document.createElement = oldDocumentCreate;
});

test("native controls delegate to Online and do not intercept Legacy routing", () => {
  const api = loadStack({ webAudio: true });
  const engine = new api.LocalTtsSpeechEngine({});
  const online = { name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true };
  engine.speak({ segments: [{ text: "online", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: online });
  engine._ensureAudioElement();
  assert.equal(engine.setPlaybackRate(1.5), true);
  assert.equal(engine.directAudio.playbackRate, 1.5);
  assert.equal(engine.setOutputVolume(1.8), true);
  assert.equal(engine.directGain.gain.value, 1.8);

  engine.cancel();
  const legacy = {
    name: "Microsoft Zira",
    lang: "en-US",
    localService: true,
    __edgeTtsSource: "chrome-tts",
    chromeVoiceName: "Microsoft Zira"
  };
  engine.speak({ segments: [{ text: "legacy", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: legacy });
  assert.equal(engine.winNaturalSessionMode, false);
  assert.equal(engine.winNaturalAudio, null, "Legacy routing must not create native audio");

  const legacyEngine = new api.LocalTtsSpeechEngine({});
  legacyEngine.speak({ segments: [{ text: "legacy", blockIndex: 0, segmentIndex: 0 }] }, 0, { voice: legacy });
  assert.equal(legacyEngine.setPlaybackRate(1.5), false);
  assert.equal(legacyEngine.setOutputVolume(1.8), false);

  const directContext = engine.directAudioContext;
  engine.dispose();
  assert.equal(engine.directAudio, null);
  assert.equal(directContext.closed, true);
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
  assert.equal(api.frames.size, 0, "audio end must tear down the native timing scheduler");
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
