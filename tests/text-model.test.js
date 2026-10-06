const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isChatGptAssistantRichDocumentContent,
  isVisuallyHiddenElement,
  relocateCursorAfterRebuild,
  relocateSegmentByLocalContext,
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


test("screen-reader-only one-pixel content is not considered readable prose", () => {
  const PreviousElement = global.Element;
  const PreviousGetComputedStyle = global.getComputedStyle;

  class MockElement {
    closest(selector) {
      return selector.includes(".sr-only") && this.srOnly ? this : null;
    }
  }

  global.Element = MockElement;
  global.getComputedStyle = (element) => element.style;

  try {
    const clipped = new MockElement();
    clipped.style = {
      opacity: "1",
      clip: "rect(0px, 0px, 0px, 0px)",
      clipPath: "none",
      width: "1px",
      height: "1px",
      position: "absolute",
      overflow: "hidden",
      whiteSpace: "nowrap"
    };
    assert.equal(isVisuallyHiddenElement(clipped), true);

    const srOnly = new MockElement();
    srOnly.srOnly = true;
    srOnly.style = {
      opacity: "1",
      clip: "auto",
      clipPath: "none",
      width: "auto",
      height: "auto",
      position: "static",
      overflow: "visible",
      whiteSpace: "normal"
    };
    assert.equal(isVisuallyHiddenElement(srOnly), true);

    const visible = new MockElement();
    visible.style = {
      opacity: "1",
      clip: "auto",
      clipPath: "none",
      width: "600px",
      height: "40px",
      position: "static",
      overflow: "visible",
      whiteSpace: "normal"
    };
    assert.equal(isVisuallyHiddenElement(visible), false);
  } finally {
    if (PreviousElement === undefined) delete global.Element;
    else global.Element = PreviousElement;

    if (PreviousGetComputedStyle === undefined) delete global.getComputedStyle;
    else global.getComputedStyle = PreviousGetComputedStyle;
  }
});


test("ChatGPT assistant rich documents are readable but outside editables are not", () => {
  const PreviousElement = global.Element;

  class MockElement {
    constructor() {
      this.messageRoot = null;
      this.documentRoot = null;
      this.containsTargets = new Set();
    }

    closest(selector) {
      if (
        selector.includes("[data-message-author-role='assistant']") &&
        this.messageRoot
      ) {
        return this.messageRoot;
      }
      if (selector.includes("contenteditable") && this.documentRoot) {
        return this.documentRoot;
      }
      return null;
    }

    contains(target) {
      return this.containsTargets.has(target);
    }
  }

  global.Element = MockElement;

  try {
    const message = new MockElement();
    const documentRoot = new MockElement();
    const paragraph = new MockElement();

    message.containsTargets.add(documentRoot);
    paragraph.messageRoot = message;
    paragraph.documentRoot = documentRoot;

    assert.equal(
      isChatGptAssistantRichDocumentContent(paragraph),
      true
    );

    const composerParagraph = new MockElement();
    composerParagraph.documentRoot = documentRoot;
    assert.equal(
      isChatGptAssistantRichDocumentContent(composerParagraph),
      false
    );
  } finally {
    if (PreviousElement === undefined) delete global.Element;
    else global.Element = PreviousElement;
  }
});

test("ChatGPT writing-block extraction keeps code editors hard-excluded", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "text-model.js"),
    "utf8"
  );

  assert.match(source, /CHATGPT_RICH_DOCUMENT_SELECTOR/);
  assert.match(source, /HARD_EDITABLE_CONTROL_SELECTOR/);
  assert.match(source, /\.monaco-editor/);
  assert.match(source, /\.CodeMirror/);
  assert.match(source, /function collectChatGptEmbeddedDocumentRoots/);
  assert.match(source, /documentRoot\.contains\?\.\(element\)/);
  assert.match(source, /candidates\.push\(documentRoot\)/);
});


test("ARIA status and alert announcements are excluded from readable prose", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "text-model.js"),
    "utf8"
  );

  assert.match(source, /\[role='status'\]/);
  assert.match(source, /\[role='alert'\]/);
  assert.match(source, /A11Y_ONLY_SELECTOR/);
  assert.match(source, /\.sr-only/);
});


test("display relocation survives an earlier token rewrite inside the same paragraph", () => {
  const anchor = {
    blockIndex: 3,
    segmentIndex: 6,
    authorRole: "assistant",
    segments: [
      { text: "This" },
      { text: "is" },
      { text: "the" },
      { text: "old" },
      { text: "paragraph" },
      { text: "and" },
      { text: "highlight" },
      { text: "must" },
      { text: "continue" }
    ]
  };

  const freshModel = {
    blocks: [
      {
        index: 3,
        authorRole: "assistant",
        segments: [
          { text: "This" },
          { text: "is" },
          { text: "the" },
          { text: "final" },
          { text: "paragraph" },
          { text: "and" },
          { text: "highlight" },
          { text: "must" },
          { text: "continue" }
        ]
      }
    ]
  };

  assert.equal(relocateCursorAfterRebuild(anchor, freshModel), null);
  assert.deepEqual(relocateSegmentByLocalContext(anchor, freshModel), {
    blockIndex: 3,
    segmentIndex: 6
  });
});

test("display relocation survives an insertion before the active word", () => {
  const anchor = {
    blockIndex: 8,
    segmentIndex: 4,
    authorRole: "assistant",
    segments: [
      { text: "Keep" },
      { text: "the" },
      { text: "current" },
      { text: "word" },
      { text: "highlighted" },
      { text: "through" },
      { text: "rerenders" }
    ]
  };

  const freshModel = {
    blocks: [
      {
        index: 8,
        authorRole: "assistant",
        segments: [
          { text: "Keep" },
          { text: "the" },
          { text: "newly" },
          { text: "current" },
          { text: "word" },
          { text: "highlighted" },
          { text: "through" },
          { text: "rerenders" }
        ]
      }
    ]
  };

  assert.deepEqual(relocateSegmentByLocalContext(anchor, freshModel), {
    blockIndex: 8,
    segmentIndex: 5
  });
});

test("display relocation refuses an ambiguous repeated token with no local context", () => {
  const anchor = {
    blockIndex: 0,
    segmentIndex: 1,
    authorRole: "assistant",
    segments: [
      { text: "alpha" },
      { text: "the" },
      { text: "omega" }
    ]
  };

  const freshModel = {
    blocks: [
      {
        index: 4,
        authorRole: "assistant",
        segments: [
          { text: "one" },
          { text: "the" },
          { text: "two" },
          { text: "the" },
          { text: "three" }
        ]
      }
    ]
  };

  assert.equal(relocateSegmentByLocalContext(anchor, freshModel), null);
});
