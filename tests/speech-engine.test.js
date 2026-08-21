const test = require("node:test");
const assert = require("node:assert/strict");

global.navigator = { language: "en-US" };
const {
  createSpeechBatch,
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

test("payload preserves paragraph boundaries when batching blocks", () => {
  const block = {
    segments: [
      { text: "First.", blockIndex: 0 },
      { text: "Second.", blockIndex: 1 }
    ]
  };

  const payload = createUtterancePayload(block, 0);
  assert.equal(payload.text, "First.\n\nSecond.");
  assert.deepEqual(payload.starts, [0, 8]);
});

test("speech batch combines short adjacent paragraphs to the target", () => {
  const blocks = [
    { segments: [{ text: "a".repeat(300), blockIndex: 0, sentenceIndex: 0 }] },
    { segments: [{ text: "b".repeat(350), blockIndex: 1, sentenceIndex: 0 }] },
    { segments: [{ text: "c".repeat(600), blockIndex: 2, sentenceIndex: 0 }] },
    { segments: [{ text: "d".repeat(600), blockIndex: 3, sentenceIndex: 0 }] }
  ];

  const batch = createSpeechBatch(blocks, 0, 0, { minChars: 1000, maxChars: 2000 });
  assert.equal(batch.endBlockIndex, 2);
  assert.equal(batch.segments.length, 3);
  assert.ok(batch.charLength >= 1000);
});

test("speech batch leaves a substantial paragraph on its own", () => {
  const blocks = [
    { segments: [{ text: "a".repeat(1300), blockIndex: 0, sentenceIndex: 0 }] },
    { segments: [{ text: "b".repeat(200), blockIndex: 1, sentenceIndex: 0 }] }
  ];

  const batch = createSpeechBatch(blocks, 0, 0, { minChars: 1200, maxChars: 2400 });
  assert.equal(batch.endBlockIndex, 0);
  assert.equal(batch.segments.length, 1);
});

test("short neighboring sentences stay in one utterance for continuous playback", () => {
  const block = {
    segments: [
      { text: "Start", sentenceIndex: 0 },
      { text: "here.", sentenceIndex: 0 },
      { text: "Next", sentenceIndex: 1 },
      { text: "sentence", sentenceIndex: 1 },
      { text: "continues.", sentenceIndex: 1 },
      { text: "Third", sentenceIndex: 2 },
      { text: "one.", sentenceIndex: 2 }
    ]
  };

  const chunks = createUtteranceChunks(block, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Start here. Next sentence continues. Third one.");
});

test("long content chunks near the target while preferring sentence boundaries", () => {
  const segments = [];
  for (let sentenceIndex = 0; sentenceIndex < 12; sentenceIndex += 1) {
    for (let wordIndex = 0; wordIndex < 12; wordIndex += 1) {
      segments.push({
        text: wordIndex === 11 ? `word${sentenceIndex}-${wordIndex}.` : `word${sentenceIndex}-${wordIndex}`,
        sentenceIndex
      });
    }
  }

  const chunks = createUtteranceChunks({ segments }, 0, {
    firstChunkMaxChars: 180,
    maxChars: 300,
    emergencyMaxChars: 5000
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].text.length >= 180);
  assert.match(chunks[0].text, /\.$/);
});

test("soft target never cuts through a normal sentence", () => {
  const segments = [];

  for (let index = 0; index < 20; index += 1) {
    segments.push({
      text: index === 19 ? "first-end." : `first-${index}`,
      sentenceIndex: 0
    });
  }
  for (let index = 0; index < 30; index += 1) {
    segments.push({
      text: index === 29 ? "second-end." : `second-${index}`,
      sentenceIndex: 1
    });
  }
  for (let index = 0; index < 20; index += 1) {
    segments.push({
      text: index === 19 ? "third-end." : `third-${index}`,
      sentenceIndex: 2
    });
  }

  const chunks = createUtteranceChunks({ segments }, 0, {
    firstChunkMaxChars: 250,
    maxChars: 300,
    emergencyMaxChars: 5000
  });

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].segments.at(-1).sentenceIndex, 1);
  assert.match(chunks[0].text, /second-end\.$/);
  assert.equal(chunks[1].segments[0].sentenceIndex, 2);
});

test("pathological unpunctuated text still respects the emergency ceiling", () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({
    text: `word${index}`,
    sentenceIndex: 0
  }));
  const chunks = createUtteranceChunks({ segments }, 0, {
    firstChunkMaxChars: 80,
    maxChars: 160,
    emergencyMaxChars: 110
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].text.length >= 110);
  assert.ok(chunks[0].text.length < 130);
});

test("natural voices sort ahead of local voices for the same language", () => {
  const local = { name: "Microsoft David", lang: "en-US", default: true };
  const natural = { name: "Microsoft Aria Online (Natural)", lang: "en-US", default: false };
  const voices = sortVoices([local, natural], "en-US", "");

  assert.equal(voices[0], natural);
  assert.equal(isNaturalVoice(voices[0]), true);
});