const test = require("node:test");
const assert = require("node:assert/strict");

global.navigator = { language: "en-US" };
const {
  createUtterancePayload,
  isNaturalVoice,
  sortVoices
} = require("../src/content/speech-engine.js");

test("createUtterancePayload remaps segment starts after a seek", () => {
  const block = {
    segments: [
      { text: "zero" },
      { text: "one" },
      { text: "two" }
    ]
  };

  const payload = createUtterancePayload(block, 1);
  assert.equal(payload.text, "one two");
  assert.deepEqual(payload.starts, [0, 4]);
  assert.equal(payload.segments.length, 2);
});

test("natural voices sort ahead of local voices for the same language", () => {
  const local = { name: "Microsoft David", lang: "en-US", default: true };
  const natural = { name: "Microsoft Aria Online (Natural)", lang: "en-US", default: false };
  const voices = sortVoices([local, natural], "en-US", "");

  assert.equal(voices[0], natural);
  assert.equal(isNaturalVoice(voices[0]), true);
});
