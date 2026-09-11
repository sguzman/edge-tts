const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("content bootstrap replaces a stale session instead of returning early", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "content-script.js"),
    "utf8"
  );

  const previousSession = source.indexOf("const previousSession = root.__EDGE_TTS_READER__");
  const staleCleanup = source.indexOf("document.querySelectorAll(\"[data-edge-tts-ui='true'], #edge-tts-toolbar\")");
  const appConstruction = source.indexOf("new extension.Reader.ReaderApp()");

  assert.ok(previousSession >= 0);
  assert.ok(staleCleanup > previousSession);
  assert.ok(appConstruction > staleCleanup);
  assert.ok(!source.includes("if (root.__EDGE_TTS_READER__) {\n    return;\n  }"));
});

test("background control messages bypass pre-reload content listeners", () => {
  const background = fs.readFileSync(
    path.join(__dirname, "..", "src", "background.js"),
    "utf8"
  );
  const content = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "content-script.js"),
    "utf8"
  );

  assert.ok(background.includes('type: "EDGE_TTS_PING_V2"'));
  assert.ok(background.includes('type: "EDGE_TTS_TOGGLE_V2"'));
  assert.ok(background.includes("response?.revision === READER_SESSION_REVISION"));
  assert.ok(content.includes('message?.type === "EDGE_TTS_PING_V2"'));
  assert.ok(content.includes('message?.type === "EDGE_TTS_TOGGLE_V2"'));
});

test("quit-during-startup is guarded by the startup fast path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  assert.ok(source.includes("if (!this.enabled || this.quitRequested)"));
  assert.ok(!source.includes("await Promise.all([settingsReady, extensionVoicesReady, winNaturalVoicesReady]);"));
});
