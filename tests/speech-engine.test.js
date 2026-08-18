const test = require("node:test");
const assert = require("node:assert/strict");

global.navigator = { language: "en-US" };
const {
  createUtteranceChunks,
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

test("first queued chunk stops at the current sentence for low seek latency", () => {
  const block = {
    segments: [
      { text: "Start", sentenceIndex: 0 },
      { text: "here.", sentenceIndex: 0 },
      { text: "Next", sentenceIndex: 1 },
      { text: "sentence", sentenceIndex: 1 },
      { text: "continues.", sentenceIndex: 1 }
    ]
  };

  const chunks = createUtteranceChunks(block, 0);
  assert.equal(chunks[0].text, "Start here.");
  assert.equal(chunks[1].text, "Next sentence continues.");
});

test("long sentences are capped instead of creating an oversized first request", () => {
  const segments = Array.from({ length: 80 }, (_, index) => ({
    text: `word${index}`,
    sentenceIndex: 0
  }));
  const chunks = createUtteranceChunks({ segments }, 0, {
    firstChunkMaxChars: 80,
    maxChars: 160,
    minChars: 80
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].text.length >= 80);
  assert.ok(chunks[0].text.length < 100);
});

test("natural voices sort ahead of local voices for the same language", () => {
  const local = { name: "Microsoft David", lang: "en-US", default: true };
  const natural = { name: "Microsoft Aria Online (Natural)", lang: "en-US", default: false };
  const voices = sortVoices([local, natural], "en-US", "");

  assert.equal(voices[0], natural);
  assert.equal(isNaturalVoice(voices[0]), true);
});
