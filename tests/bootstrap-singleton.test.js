const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("content bootstrap removes orphaned reader UI before constructing a fresh app", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "content-script.js"),
    "utf8"
  );

  const guard = source.indexOf("if (root.__EDGE_TTS_READER__)");
  const staleCleanup = source.indexOf("document.querySelectorAll(\"[data-edge-tts-ui='true'], #edge-tts-toolbar\")");
  const appConstruction = source.indexOf("new extension.Reader.ReaderApp()");

  assert.ok(guard >= 0);
  assert.ok(staleCleanup > guard);
  assert.ok(appConstruction > staleCleanup);
});

test("quit-during-startup is guarded by the startup fast path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  assert.ok(source.includes("if (!this.enabled || this.quitRequested)"));
  assert.ok(!source.includes("await Promise.all([settingsReady, extensionVoicesReady, winNaturalVoicesReady]);"));
});
