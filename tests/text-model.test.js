const test = require("node:test");
const assert = require("node:assert/strict");
const {
  relocateCursorAfterRebuild,
  segmentIndexForCharIndex,
  segmentIsLive,
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
  assert.equal(siteProfileForHostname("x.com"), "x");
  assert.equal(siteProfileForHostname("www.x.com"), "x");
  assert.equal(siteProfileForHostname("twitter.com"), "x");
  assert.equal(siteProfileForHostname("mobile.twitter.com"), "x");
  assert.equal(siteProfileForHostname("example.com"), "generic");
});


test("X profile targets tweetText application containers", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "text-model.js"),
    "utf8"
  );

  assert.match(source, /\[data-testid='tweetText'\]/);
  assert.match(source, /function collectXCandidates/);
  assert.match(source, /profile === "x"/);
});


test("segmentIsLive rejects detached or rewritten text-node targets", () => {
  const PreviousText = global.Text;
  class MockText {}
  global.Text = MockText;

  try {
    const node = new MockText();
    node.isConnected = true;
    node.nodeValue = "Hello world";

    const segment = {
      node,
      nodeStart: 0,
      nodeEnd: 5,
      text: "Hello"
    };

    assert.equal(segmentIsLive(segment), true);

    node.nodeValue = "Hallo world";
    assert.equal(segmentIsLive(segment), false);

    node.nodeValue = "Hello world";
    node.isConnected = false;
    assert.equal(segmentIsLive(segment), false);
  } finally {
    if (PreviousText === undefined) delete global.Text;
    else global.Text = PreviousText;
  }
});

test("cursor relocation survives a rerender when token prefix is unchanged", () => {
  const anchor = {
    blockIndex: 4,
    segmentIndex: 2,
    authorRole: "assistant",
    segments: [
      { text: "The" },
      { text: "answer" },
      { text: "continues" },
      { text: "here" }
    ]
  };

  const freshModel = {
    blocks: [
      {
        index: 7,
        authorRole: "assistant",
        segments: [
          { text: "The" },
          { text: "answer" },
          { text: "continues" },
          { text: "here" },
          { text: "now" }
        ]
      }
    ]
  };

  assert.deepEqual(relocateCursorAfterRebuild(anchor, freshModel), {
    blockIndex: 7,
    segmentIndex: 2
  });
});

test("cursor relocation refuses a changed prefix at the active token", () => {
  const anchor = {
    blockIndex: 1,
    segmentIndex: 1,
    authorRole: "assistant",
    segments: [
      { text: "Original" },
      { text: "token" },
      { text: "tail" }
    ]
  };
  const freshModel = {
    blocks: [
      {
        index: 1,
        authorRole: "assistant",
        segments: [
          { text: "Original" },
          { text: "replacement" },
          { text: "tail" }
        ]
      }
    ]
  };

  assert.equal(relocateCursorAfterRebuild(anchor, freshModel), null);
});
