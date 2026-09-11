const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = { SpeechEngine: { SpeechEngine: class {}, createUtteranceChunks() { return []; } } };
const { isWinNaturalVoice, mergeVoices, nativeVoiceToCatalogVoice } = require("../src/content/win-natural-engine.js");

test("native SAPI voices are source-tagged Windows Natural catalog entries", () => {
  const voice = nativeVoiceToCatalogVoice({ id: "Local-aria-v2", name: "Microsoft Aria", lang: "en-US" });
  assert.deepEqual(voice, {
    name: "Microsoft Aria", lang: "en-US", localService: true, default: false,
    voiceURI: "win-natural:Local-aria-v2", __edgeTtsSource: "win-natural", voiceId: "Local-aria-v2",
    eventTypes: ["start", "word", "sentence", "end"]
  });
  assert.equal(isWinNaturalVoice(voice), true);
});

test("Windows Natural catalog entries do not duplicate Web Speech entries", () => {
  const existing = { name: "Microsoft Aria", lang: "en-US", localService: true };
  const merged = mergeVoices([existing], [{ id: "Local-aria-v2", name: "Microsoft Aria", lang: "en-US" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].__edgeTtsSource, "win-natural");
});
