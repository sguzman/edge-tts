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
  approximatePiperBoundaries
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


test("approximate Piper boundaries account for punctuation pauses", () => {
  const payload = {
    text: "alpha, beta gamma.",
    starts: [0, 7, 12],
    segments: [
      { text: "alpha,", segmentIndex: 0 },
      { text: "beta", segmentIndex: 1 },
      { text: "gamma.", segmentIndex: 2 }
    ]
  };

  const boundaries = approximatePiperBoundaries(payload, 3000);
  assert.equal(boundaries.length, 3);
  assert.equal(boundaries[0].offsetSeconds, 0);
  assert.ok(
    boundaries[1].offsetSeconds > 0.8,
    "comma pause should delay the next visible word"
  );
  assert.equal(boundaries[0].segment, payload.segments[0]);
});
