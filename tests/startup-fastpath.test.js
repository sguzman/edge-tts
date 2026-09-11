const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.EdgeTtsExtension = {};
const { startupSummary } = require("../src/content/startup-fastpath.js");

test("startup summary separates extension prep from remote speech latency", () => {
  const summary = startupSummary({
    totalMs: 910,
    prepMs: 74,
    speechStartMs: 836,
    modelMs: 21,
    extraVoiceWaitMs: 0
  });

  assert.equal(
    summary,
    "total 910 ms · prep 74 ms · remote speech 836 ms · model 21 ms · extra voice wait 0 ms"
  );
});

test("voice readiness starts before text modeling without blocking startup on WIN-NATURAL", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  const localVoiceWait = source.indexOf("this.speech.refreshExtensionVoices?.()");
  const nativeVoiceWait = source.indexOf("this.speech.refreshWinNaturalVoices?.()");
  const naturalVoiceWait = source.indexOf("this.speech.waitForVoices(");
  const modelBuild = source.indexOf("this.rebuildModel();");
  const awaitPrep = source.indexOf("await Promise.all([settingsReady, extensionVoicesReady]);");
  const forbiddenNativeAwait = source.indexOf(
    "await Promise.all([settingsReady, extensionVoicesReady, winNaturalVoicesReady]);"
  );
  const firstRefresh = source.indexOf("this.refreshVoices();", awaitPrep);
  const awaitNaturalFallback = source.indexOf("await naturalVoicesReady;", firstRefresh);

  assert.ok(localVoiceWait >= 0);
  assert.ok(nativeVoiceWait > localVoiceWait);
  assert.ok(naturalVoiceWait > localVoiceWait);
  assert.ok(modelBuild > naturalVoiceWait);
  assert.ok(awaitPrep > modelBuild);
  assert.equal(forbiddenNativeAwait, -1);
  assert.ok(firstRefresh > awaitPrep);
  assert.ok(awaitNaturalFallback > firstRefresh);
});

test("startup aborts cleanly when the reader is closed or quit during async preparation", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  const guard = "if (!this.enabled || this.quitRequested)";
  assert.ok(source.split(guard).length - 1 >= 3);
});
