const test = require("node:test");
const assert = require("node:assert/strict");

global.Text = class Text {};
global.EdgeTtsExtension = {
  TextModel: {
    findSegmentInNode(block, node, offset) {
      return block.segments.find((segment) => segment.node === node && offset >= 0) || null;
    },
    buildReadableModel() { return { blocks: [], nodeToBlock: new Map() }; }
  },
  Highlighter: { Highlighter: class {}, DEFAULT_SENTENCE_COLOR: "", DEFAULT_WORD_COLOR: "", normalizeColor: value => value },
  SpeechEngine: {
    SpeechEngine: class {},
    createSpeechBatch() {},
    isCatalogOnlyVoice() { return false; },
    isNaturalVoice() { return false; },
    selectStartupVoice() {},
    selectPlayableVoice() {},
    voiceSelectionKey() { return ""; }
  },
  Toolbar: { Toolbar: class {} }
};
require("../src/content/reader.js");
const { resolveClickTarget } = global.EdgeTtsExtension.Reader;

function modelFor(node) {
  const segment = { node, segmentIndex: 0 };
  const block = { index: 0, segments: [segment], nodeToBlock: new Map([[node, { index: 0, segments: [segment] }]]) };
  return { blocks: [block], nodeToBlock: block.nodeToBlock };
}

function appFor(oldNode, newNode) {
  const app = {
    stopped: false,
    paused: false,
    model: modelFor(oldNode),
    rebuilds: 0,
    caretFromPoint() { return { node: newNode, offset: 0 }; },
    rebuildModel() {
      this.rebuilds += 1;
      this.model = modelFor(newNode);
    }
  };
  return app;
}

test("paused reader rebuilds before resolving a replaced text node", () => {
  const oldNode = new Text();
  const newNode = new Text();
  const app = appFor(oldNode, newNode);
  app.paused = true;
  const result = resolveClickTarget(app, { clientX: 1, clientY: 2 });
  assert.equal(result.segment.node, newNode);
  assert.equal(app.rebuilds, 1);
});

test("stopped reader rebuilds before resolving a replaced text node", () => {
  const oldNode = new Text();
  const newNode = new Text();
  const app = appFor(oldNode, newNode);
  app.stopped = true;
  assert.ok(resolveClickTarget(app, { clientX: 1, clientY: 2 }));
  assert.equal(app.rebuilds, 1);
});

test("healthy active model resolves without an unnecessary rebuild", () => {
  const node = new Text();
  const app = appFor(node, node);
  assert.ok(resolveClickTarget(app, { clientX: 1, clientY: 2 }));
  assert.equal(app.rebuilds, 0);
});

test("active stale lookup retries after at most one model rebuild", () => {
  const oldNode = new Text();
  const newNode = new Text();
  const app = appFor(oldNode, newNode);
  assert.ok(resolveClickTarget(app, { clientX: 1, clientY: 2 }));
  assert.equal(app.rebuilds, 1);

  app.caretFromPoint = () => ({ node: new Text(), offset: 0 });
  assert.equal(resolveClickTarget(app, { clientX: 1, clientY: 2 }), null);
  assert.equal(app.rebuilds, 2);
});
