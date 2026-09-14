const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createTransport,
  installDiagnosticsListener
} = require("../src/background/native-messaging.js");

function fakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    sent: [],
    postMessage(message) {
      this.sent.push(message);
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
    emit(message) {
      for (const listener of messageListeners) listener(message);
    }
  };
}

function fakeRuntime() {
  const listeners = [];
  return {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    listeners,
    dispatch(message, sender = { tab: { id: 7 } }) {
      let response;
      const sendResponse = (value) => { response = value; };
      const returns = listeners.map((listener) => listener(message, sender, sendResponse));
      return { response, returns };
    }
  };
}

test("Native Messaging handshake and filtered voice enumeration succeed", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 100 });
  const pending = transport.diagnostics();
  assert.equal(port.sent[0].type, "hello");
  port.emit({ type: "hello", requestId: port.sent[0].requestId, protocol: 1, architecture: "x64" });
  await Promise.resolve();
  assert.equal(port.sent[1].type, "voices");
  port.emit({
    type: "voices",
    requestId: port.sent[1].requestId,
    voices: [
      { id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" },
      { id: "Microsoft David Desktop", name: "Microsoft David", lang: "en-US" }
    ]
  });
  const result = await pending;
  assert.equal(result.connected, true);
  assert.deepEqual(result.handshake, { protocol: 1, architecture: "x64" });
  assert.deepEqual(result.voices.map((voice) => voice.id), ["Local-NarratorVoices"]);
  assert.equal(result.ariaFound, true);
  assert.deepEqual(result.ariaVoice, { id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" });
});

test("one transport reuses a healthy port and reports disconnect for cache invalidation", async () => {
  const ports = [];
  let connects = 0;
  let disconnects = 0;
  const transport = createTransport({
    connectNative: () => {
      connects += 1;
      const port = fakePort();
      ports.push(port);
      return port;
    },
    onDisconnect: () => { disconnects += 1; },
    now: () => 150
  });

  const first = transport.request("hello");
  ports[0].emit({ type: "hello", requestId: ports[0].sent[0].requestId, protocol: 1, architecture: "x64" });
  await first;
  const second = transport.request("voices");
  ports[0].emit({ type: "voices", requestId: ports[0].sent[1].requestId, voices: [] });
  await second;
  assert.equal(connects, 1);

  const disconnected = transport.request("voices");
  ports[0].disconnect();
  await assert.rejects(disconnected, /disconnected/);
  assert.equal(disconnects, 1);
});

function startMultipartRequest() {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 400 });
  const pending = transport.requestMultipart("synthesize", { voiceId: "Local-NarratorVoices", text: "test" });
  const request = port.sent[0];
  port.emit({ type: "synth-start", requestId: request.requestId, totalBytes: 5, chunkCount: 2 });
  return { port, pending, request };
}

test("multipart synthesis reconstructs start/chunk/end in order", async () => {
  const { port, pending, request } = startMultipartRequest();
  port.emit({ type: "synth-chunk", requestId: request.requestId, index: 0, data: Buffer.from("he").toString("base64") });
  port.emit({ type: "synth-chunk", requestId: request.requestId, index: 1, data: Buffer.from("llo").toString("base64") });
  port.emit({
    type: "synth-end",
    requestId: request.requestId,
    totalBytes: 5,
    chunkCount: 2,
    latencyDiagnostics: {
      textChars: 4,
      speakMs: 12.5,
      pcmDurationMs: 500
    },
    timing: [
      { charIndex: 0, charLength: 2, audioMs: 0 },
      { charIndex: 2, charLength: 2, audioMs: 143.25 }
    ]
  });
  const result = await pending;
  assert.equal(Buffer.from(result.wavBase64, "base64").toString(), "hello");
  assert.equal(result.totalBytes, 5);
  assert.deepEqual(result.timing, [
    { charIndex: 0, charLength: 2, audioMs: 0 },
    { charIndex: 2, charLength: 2, audioMs: 143.25 }
  ]);
  assert.equal(result.latencyDiagnostics.nativePort, "new");
  assert.equal(result.latencyDiagnostics.textChars, 4);
  assert.equal(result.latencyDiagnostics.speakMs, 12.5);
  assert.equal(typeof result.latencyDiagnostics.backgroundTotalMs, "number");
});

test("multipart latency diagnostics distinguish a new port from a reused warm port", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 400 });
  const complete = async (text, value) => {
    const pending = transport.requestMultipart("synthesize", { text });
    const request = port.sent.at(-1);
    port.emit({ type: "synth-start", requestId: request.requestId, totalBytes: 1, chunkCount: 1 });
    port.emit({ type: "synth-chunk", requestId: request.requestId, index: 0, data: Buffer.from(value).toString("base64") });
    port.emit({
      type: "synth-end",
      requestId: request.requestId,
      totalBytes: 1,
      chunkCount: 1,
      latencyDiagnostics: { synthesizerWarm: true }
    });
    return pending;
  };
  const first = await complete("first", "a");
  const second = await complete("second", "b");
  assert.equal(first.latencyDiagnostics.nativePort, "new");
  assert.equal(second.latencyDiagnostics.nativePort, "reused");
  assert.equal(second.latencyDiagnostics.synthesizerWarm, true);
});

test("multipart synthesis contains malformed timing without weakening WAV validation", async () => {
  const { port, pending, request } = startMultipartRequest();
  port.emit({ type: "synth-chunk", requestId: request.requestId, index: 0, data: Buffer.from("he").toString("base64") });
  port.emit({ type: "synth-chunk", requestId: request.requestId, index: 1, data: Buffer.from("llo").toString("base64") });
  port.emit({
    type: "synth-end",
    requestId: request.requestId,
    totalBytes: 5,
    chunkCount: 2,
    timing: [
      { charIndex: 0, charLength: 2, audioMs: 10 },
      { charIndex: 99, charLength: 2, audioMs: 20 },
      { charIndex: 2, charLength: 2, audioMs: 5 }
    ]
  });
  const result = await pending;
  assert.equal(Buffer.from(result.wavBase64, "base64").toString(), "hello");
  assert.deepEqual(result.timing, [{ charIndex: 0, charLength: 2, audioMs: 10 }]);
});

for (const [name, emitInvalid] of [
  ["missing chunk", (port, id) => port.emit({ type: "synth-end", requestId: id, totalBytes: 5, chunkCount: 2 })],
  ["duplicate chunk", (port, id) => {
    const data = Buffer.from("he").toString("base64");
    port.emit({ type: "synth-chunk", requestId: id, index: 0, data });
    port.emit({ type: "synth-chunk", requestId: id, index: 0, data });
  }],
  ["out-of-order chunk", (port, id) => port.emit({ type: "synth-chunk", requestId: id, index: 1, data: Buffer.from("hello").toString("base64") })],
  ["malformed base64", (port, id) => port.emit({ type: "synth-chunk", requestId: id, index: 0, data: "not base64!" })],
  ["byte-total mismatch", (port, id) => {
    port.emit({ type: "synth-chunk", requestId: id, index: 0, data: Buffer.from("hello").toString("base64") });
    port.emit({ type: "synth-end", requestId: id, totalBytes: 4, chunkCount: 2 });
  }]
]) {
  test(`multipart synthesis rejects ${name}`, async () => {
    const { port, pending, request } = startMultipartRequest();
    emitInvalid(port, request.requestId);
    await assert.rejects(pending, /incomplete|out of order|Malformed|exceeds/);
  });
}

test("multipart synthesis enforces the 8 MiB response bound", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 500 });
  const pending = transport.requestMultipart("synthesize");
  const request = port.sent[0];
  port.emit({ type: "synth-start", requestId: request.requestId, totalBytes: 8 * 1024 * 1024 + 1, chunkCount: 1 });
  await assert.rejects(pending, /Invalid native synthesis size/);
});

test("Aria detection uses the adapter prefix and voice identity, not a canonical token ID", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 100 });
  const pending = transport.diagnostics();
  port.emit({ type: "hello", requestId: port.sent[0].requestId, protocol: 1, architecture: "x64" });
  await Promise.resolve();
  port.emit({
    type: "voices",
    requestId: port.sent[1].requestId,
    voices: [
      { id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" },
      { id: "Local-other", name: "Microsoft Aria", lang: "fr-FR" },
      { id: "Microsoft-Aria", name: "Microsoft Aria", lang: "en-US" }
    ]
  });
  const result = await pending;
  assert.deepEqual(result.voices.map((voice) => voice.id), ["Local-NarratorVoices", "Local-other"]);
  assert.equal(result.ariaFound, true);
  assert.equal(result.ariaVoice.id, "Local-NarratorVoices");
});

test("diagnostic listener ignores existing audio messages and has no eager native work", () => {
  const runtime = fakeRuntime();
  let connectCount = 0;
  const transport = createTransport({
    connectNative: () => {
      connectCount += 1;
      return fakePort();
    }
  });
  let createCount = 0;
  installDiagnosticsListener(runtime, () => {
    createCount += 1;
    return transport;
  }, { warn() {} });
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EDGE_TTS_AUDIO_CLAIM") {
      sendResponse({ granted: true });
      return true;
    }
    if (message?.type === "EDGE_TTS_AUDIO_RELEASE") {
      sendResponse({ released: true });
      return true;
    }
    return false;
  });

  const claim = runtime.dispatch({ type: "EDGE_TTS_AUDIO_CLAIM" });
  const release = runtime.dispatch({ type: "EDGE_TTS_AUDIO_RELEASE" });
  assert.deepEqual(claim.returns, [false, true]);
  assert.deepEqual(release.returns, [false, true]);
  assert.deepEqual(claim.response, { granted: true });
  assert.deepEqual(release.response, { released: true });
  assert.equal(connectCount, 0);
  assert.equal(createCount, 0);

  const diagnostic = runtime.dispatch({ type: "EDGE_TTS_NATIVE_DIAGNOSTICS" });
  assert.deepEqual(diagnostic.returns, [true, false]);
  assert.equal(createCount, 1);
  assert.equal(connectCount, 1);
  transport.disconnect();
});

test("Native Messaging request timeout is bounded", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 200 });
  await assert.rejects(transport.request("hello", {}, 10), /timed out: hello/);
});

test("Native host errors and disconnects reject the matching request", async () => {
  const port = fakePort();
  const transport = createTransport({ connectNative: () => port, now: () => 300 });
  const pending = transport.request("voices");
  port.emit({ type: "error", requestId: port.sent[0].requestId, message: "malformed response" });
  await assert.rejects(pending, /malformed response/);

  const malformed = transport.request("voices");
  port.emit({ requestId: port.sent[1].requestId });
  await assert.rejects(malformed, /Malformed Native Messaging response/);

  const disconnected = transport.request("voices");
  port.disconnect();
  await assert.rejects(disconnected, /disconnected/);
});

test("native discovery is not part of reader startup or the runtime dispatcher", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
  const openStart = background.indexOf("chrome.action.onClicked");
  const listenerCount = (background.match(/chrome\.runtime\.onMessage\.addListener\(/g) || []).length;
  assert.ok(openStart >= 0);
  assert.equal(listenerCount, 1);
  assert.equal(background.slice(openStart).includes("nativeMessaging.diagnostics()"), false);
  assert.equal(background.includes("installDiagnosticsListener"), false);
  assert.match(background, /EDGE_TTS_WIN_NATURAL_VOICES/);
  assert.match(background, /getNativeTransport\(\)/);
  assert.match(background, /EDGE_TTS_WIN_NATURAL_DIAGNOSTICS/);
  assert.match(background, /EDGE_TTS_WIN_NATURAL_SYNTHESIZE/);
  const startup = fs.readFileSync(path.join(__dirname, "..", "src", "content", "startup-fastpath.js"), "utf8");
  assert.equal(startup.includes("refreshWinNaturalVoices"), false);
});

test("Gate 3C keeps native playback isolated to the existing local engine and watchdog boundary", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
  assert.equal(background.includes("win-natural-speech-engine.js"), false);
  for (const file of [
    "direct-audio-engine.js",
    "reliable-speech-engine.js",
    "voice-ui.js",
    "toolbar.js",
    "audio-controls.js",
    "startup-fastpath.js",
    "content-script.js"
  ]) {
    const current = fs.readFileSync(path.join(__dirname, "..", "src", "content", file), "utf8");
    const baseline = require("node:child_process").execFileSync("git", ["show", `8c4025e:src/content/${file}`], { encoding: "utf8" });
    assert.equal(current, baseline, `${file} must remain Gate-2 identical`);
  }
  const local = fs.readFileSync(path.join(__dirname, "..", "src", "content", "local-tts-engine.js"), "utf8");
  assert.match(local, /EDGE_TTS_WIN_NATURAL_SYNTHESIZE/);
  const speechEngine = fs.readFileSync(path.join(__dirname, "..", "src", "content", "speech-engine.js"), "utf8");
  assert.match(speechEngine, /return voice\?\.catalogOnly === true;/);
  const reliableReader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reliable-reader.js"), "utf8");
  assert.match(reliableReader, /ownsCompletionWithoutBoundaries/);
  const failsafeReader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "failsafe-reader.js"), "utf8");
  assert.match(failsafeReader, /ownsCompletionWithoutBoundaries/);
  const reader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");
  assert.match(reader, /voice\.__edgeTtsSource === "win-natural"/);
  assert.match(reader, /prepareDirectPlayback\?\.\(voice\)/);
});

test("Gate 3B diagnostics are background-owned and extension-page synthesis needs no tab", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
  assert.match(background, /let nativeTransport = null/);
  assert.match(background, /nativeMessagingApi\.createTransport\(\{\s*onDisconnect/s);
  assert.match(background, /transport\.requestMultipart\(/);
  const synthesisStart = background.indexOf('message?.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE"');
  assert.ok(synthesisStart >= 0);
  const synthesisBranch = background.slice(synthesisStart, background.indexOf("return true;", synthesisStart));
  assert.doesNotMatch(synthesisBranch, /No content tab|Number\.isInteger\(tabId\)|sender\.tab/);
  assert.equal((background.match(/chrome\.runtime\.onMessage\.addListener\(/g) || []).length, 1);
});
