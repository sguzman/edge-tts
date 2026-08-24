const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const toolbarSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "toolbar.js"),
  "utf8"
);
const readerSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const contentScriptSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "content-script.js"),
  "utf8"
);

test("Quit is built directly into the stable toolbar and remains in the header", () => {
  assert.match(toolbarSource, /data-edge-tts-action="quit"/);
  assert.match(toolbarSource, /this\.handlers\.onQuit\?\.\(\)/);
  assert.match(toolbarSource, /destroy\(\) \{/);

  const headerStart = toolbarSource.indexOf('<div class="edge-tts-header"');
  const headerEnd = toolbarSource.indexOf("</div>", headerStart);
  const quitButton = toolbarSource.indexOf('data-edge-tts-action="quit"');
  assert.ok(headerStart >= 0);
  assert.ok(quitButton > headerStart && quitButton < headerEnd);
});

test("Reader owns Quit directly so no lifecycle subclass can perturb startup", () => {
  assert.match(readerSource, /onQuit: \(\) => this\.quit\(\)/);
  assert.match(readerSource, /quit\(\) \{/);
  assert.match(readerSource, /this\.stop\(\)/);
  assert.match(readerSource, /this\.unsubscribeVoiceChanges\?\.\(\)/);
  assert.match(readerSource, /this\.toolbar\.destroy\?\.\(\)/);
  assert.match(readerSource, /root\.__EDGE_TTS_READER__\?\.detach\?\.\(this\)/);
});

test("Quit leaves only a dormant wake listener and next toggle constructs a fresh Reader", () => {
  assert.match(contentScriptSource, /let app = new extension\.Reader\.ReaderApp\(\)/);
  assert.match(contentScriptSource, /app = null/);
  assert.match(contentScriptSource, /if \(!app\) \{\s*app = new extension\.Reader\.ReaderApp\(\)/s);
  assert.match(contentScriptSource, /sendResponse\(\{ ready: true, active: Boolean\(app\) \}\)/);
  assert.doesNotMatch(contentScriptSource, /onMessage\.removeListener/);
  assert.doesNotMatch(contentScriptSource, /EDGE_TTS_SESSION_QUIT/);
});
