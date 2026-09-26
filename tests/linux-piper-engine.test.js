const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() { return []; }
  }
};

const {
  isLinuxPiperVoice,
  mergeVoices,
  nativeVoiceToCatalogVoice,
  piperRatePlan
} = require("../src/content/linux-piper-engine.js");

test("Piper voices are source-tagged Linux local catalog entries", () => {
  const voice = nativeVoiceToCatalogVoice({
    id: "en_US-ryan-high",
    name: "Ryan High",
    lang: "en-US",
    quality: "high"
  });

  assert.deepEqual(voice, {
    name: "Ryan High",
    lang: "en-US",
    localService: true,
    default: false,
    voiceURI: "linux-piper:en_US-ryan-high",
    __edgeTtsSource: "linux-piper",
    voiceId: "en_US-ryan-high",
    quality: "high",
    eventTypes: ["start", "word", "sentence", "end"]
  });
  assert.equal(isLinuxPiperVoice(voice), true);
});

test("Piper catalog entries replace duplicate generic local entries", () => {
  const existing = { name: "Ryan High", lang: "en-US", localService: true };
  const merged = mergeVoices(
    [existing],
    [{ id: "en_US-ryan-high", name: "Ryan High", lang: "en-US", quality: "high" }]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].__edgeTtsSource, "linux-piper");
});


test("Piper speed keeps moderate timing inside the model and leaves only residual browser rate", () => {
  assert.deepEqual(piperRatePlan(1), {
    requestedRate: 1,
    lengthScale: 1,
    playbackRate: 1
  });

  const faster = piperRatePlan(2);
  assert.equal(faster.requestedRate, 2);
  assert.equal(faster.lengthScale, 0.8);
  assert.equal(faster.playbackRate, 1.6);

  const slower = piperRatePlan(0.5);
  assert.equal(slower.requestedRate, 0.5);
  assert.ok(slower.lengthScale > 1);
  assert.ok(slower.playbackRate < 1);
});
