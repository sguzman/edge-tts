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

test("voice readiness starts before text modeling and catalog selection waits for local voices", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  const localVoiceWait = source.indexOf("this.speech.refreshExtensionVoices?.()");
  const nativeVoiceWait = source.indexOf("this.speech.refreshWinNaturalVoices?.()");
  const naturalVoiceWait = source.indexOf("this.speech.waitForVoices(");
  const modelBuild = source.indexOf("this.rebuildModel();");
  const awaitPrep = source.indexOf("await Promise.all([settingsReady, extensionVoicesReady, winNaturalVoicesReady]);");
  const firstRefresh = source.indexOf("this.refreshVoices();", awaitPrep);
  const awaitNaturalFallback = source.indexOf("await naturalVoicesReady;", firstRefresh);

  assert.ok(localVoiceWait >= 0);
  assert.ok(nativeVoiceWait > localVoiceWait);
  assert.ok(naturalVoiceWait > localVoiceWait);
  assert.ok(modelBuild > naturalVoiceWait);
  assert.ok(awaitPrep > modelBuild);
  assert.ok(firstRefresh > awaitPrep);
  assert.ok(awaitNaturalFallback > firstRefresh);
});
