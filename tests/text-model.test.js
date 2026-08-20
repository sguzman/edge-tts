const test = require("node:test");
const assert = require("node:assert/strict");
const {
  segmentIndexForCharIndex,
  sentenceRanges,
  siteProfileForHostname,
  tokenizeText
} = require("../src/content/text-model.js");

test("tokenizeText preserves token offsets", () => {
  assert.deepEqual(tokenizeText("  Hello,   world! "), [
    { text: "Hello,", start: 2, end: 8 },
    { text: "world!", start: 11, end: 17 }
  ]);
});

test("sentenceRanges finds adjacent sentence spans", () => {
  const text = "Hello world. This is sentence two! And three?";
  const ranges = sentenceRanges(text, "en-US");
  assert.equal(ranges.length, 3);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), "Hello world.");
  assert.equal(text.slice(ranges[1].start, ranges[1].end), "This is sentence two!");
  assert.equal(text.slice(ranges[2].start, ranges[2].end), "And three?");
});

test("segmentIndexForCharIndex returns the nearest segment at or before the boundary", () => {
  const starts = [0, 6, 12, 20];
  assert.equal(segmentIndexForCharIndex(starts, 0), 0);
  assert.equal(segmentIndexForCharIndex(starts, 7), 1);
  assert.equal(segmentIndexForCharIndex(starts, 19), 2);
  assert.equal(segmentIndexForCharIndex(starts, 999), 3);
});

test("ChatGPT hosts use the message-only reading profile", () => {
  assert.equal(siteProfileForHostname("chatgpt.com"), "chatgpt");
  assert.equal(siteProfileForHostname("www.chatgpt.com"), "chatgpt");
  assert.equal(siteProfileForHostname("chat.openai.com"), "chatgpt");
  assert.equal(siteProfileForHostname("example.com"), "generic");
});
