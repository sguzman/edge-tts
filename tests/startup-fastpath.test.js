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

test("Natural voice readiness starts before text modeling", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  const voiceWait = source.indexOf("this.speech.waitForVoices(");
  const modelBuild = source.indexOf("this.rebuildModel();");
  const awaitSettings = source.indexOf("await settingsReady;");
  const awaitVoices = source.indexOf("await naturalVoicesReady;");

  assert.ok(voiceWait >= 0);
  assert.ok(modelBuild > voiceWait);
  assert.ok(awaitSettings > modelBuild);
  assert.ok(awaitVoices > awaitSettings);
});
