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
  assert.match(background, /createTransport\(\)\.request\("voices"\)/);
  const startup = fs.readFileSync(path.join(__dirname, "..", "src", "content", "startup-fastpath.js"), "utf8");
  assert.equal(startup.includes("refreshWinNaturalVoices"), false);
});
