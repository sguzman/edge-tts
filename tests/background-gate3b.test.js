const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);

function createBackgroundHarness() {
  let dispatcher;
  let created = 0;
  const transports = [];
  const transportFactory = {
    createTransport(options) {
      created += 1;
      const transport = {
        diagnostics: async () => ({
          connected: true,
          handshake: { protocol: 1, architecture: "x64" },
          voices: [{ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }],
          ariaFound: true,
          ariaVoice: { id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }
        }),
        request: async () => ({ voices: [] }),
        requestMultipart: async (_type, payload) => ({
          type: "synthesize",
          voiceId: payload.voiceId,
          totalBytes: 3,
          wavBase64: "d2F2"
        }),
        disconnect() { options.onDisconnect?.(); },
        drop() { options.onDisconnect?.(); }
      };
      transports.push(transport);
      return transport;
    },
    SYNTHESIS_TIMEOUT_MS: 30_000
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { dispatcher = listener; } },
      lastError: null
    },
    storage: {
      session: {
        async get() { return {}; },
        async set() {},
        async remove() {}
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      async sendMessage() { return {}; }
    },
    scripting: {
      async insertCSS() {},
      async executeScript() {}
    },
    action: { onClicked: { addListener() {} } },
    tts: {}
  };
  const context = { chrome, EdgeTtsNativeMessaging: transportFactory, console };
  vm.runInNewContext(backgroundSource, context);
  return {
    transports,
    get created() { return created; },
    dispatch(message, sender = {}) {
      return new Promise((resolve) => {
        const returned = dispatcher(message, sender, resolve);
        if (returned === false) resolve(undefined);
      });
    }
  };
}

test("background-owned diagnostics reuse, handle extension pages, and reconnect", async () => {
  const harness = createBackgroundHarness();
  const first = await harness.dispatch({ type: "EDGE_TTS_WIN_NATURAL_DIAGNOSTICS" });
  assert.equal(first.handshake.architecture, "x64");
  const synthesis = await harness.dispatch({
    type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE",
    voiceId: "Local-NarratorVoices",
    text: "diagnostic"
  });
  assert.equal(synthesis.accepted, true);
  assert.equal(synthesis.voiceId, "Local-NarratorVoices");
  assert.equal(harness.created, 1);

  harness.transports[0].drop();
  const reconnected = await harness.dispatch({ type: "EDGE_TTS_WIN_NATURAL_DIAGNOSTICS" });
  assert.equal(reconnected.connected, true);
  assert.equal(harness.created, 2);
});
