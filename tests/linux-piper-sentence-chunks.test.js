const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() { return []; }
  },
  TextModel: {}
};

const {
  createPiperSentenceChunks
} = require("../src/content/linux-piper-engine.js");

test("Piper chunks follow actual block+sentence boundaries", () => {
  const segments = [
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 0, text: "This" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 1, text: "is" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 2, text: "one." },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 3, text: "This" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 4, text: "is" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 5, text: "two." },
    { blockIndex: 1, sentenceIndex: 0, segmentIndex: 0, text: "Third" },
    { blockIndex: 1, sentenceIndex: 0, segmentIndex: 1, text: "sentence." }
  ];

  const chunks = createPiperSentenceChunks({ segments }, 0);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    "This is one.",
    "This is two.",
    "Third sentence."
  ]);
});

test("Piper sentence chunking honors a mid-sentence resume cursor", () => {
  const segments = [
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 0, text: "Skip" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 1, text: "to" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 2, text: "here." },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 3, text: "Next" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 4, text: "sentence." }
  ];

  const chunks = createPiperSentenceChunks({ segments }, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    "to here.",
    "Next sentence."
  ]);
});
