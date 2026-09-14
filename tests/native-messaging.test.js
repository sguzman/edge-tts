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
      { id: "Local-aria-v2", name: "Microsoft Aria", lang: "en-US" },
      { id: "Microsoft David Desktop", name: "Microsoft David", lang: "en-US" }
    ]
  });
  const result = await pending;
  assert.equal(result.connected, true);
  assert.deepEqual(result.handshake, { protocol: 1, architecture: "x64" });
  assert.deepEqual(result.voices.map((voice) => voice.id), ["Local-aria-v2"]);
  assert.equal(result.ariaFound, true);
  assert.deepEqual(result.ariaVoice, { id: "Local-aria-v2", name: "Microsoft Aria", lang: "en-US" });
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

test("native discovery is not part of reader startup", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
  const openStart = background.indexOf("chrome.action.onClicked");
  const listenerCount = (background.match(/chrome\.runtime\.onMessage\.addListener\(/g) || []).length;
  const dispatcherStart = background.indexOf("chrome.runtime.onMessage.addListener");
  const installStart = background.indexOf("nativeMessagingApi.installDiagnosticsListener");
  assert.ok(openStart >= 0);
  assert.equal(listenerCount, 1);
  assert.ok(dispatcherStart >= 0);
  assert.ok(installStart > dispatcherStart);
  assert.equal(background.slice(openStart).includes("nativeMessaging.diagnostics()"), false);
});
