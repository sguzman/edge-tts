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

test("content-script detaches the runtime listener so the next icon click reinjects", () => {
  assert.match(contentScriptSource, /onMessage\.removeListener\(onMessage\)/);
  assert.match(contentScriptSource, /delete root\.__EDGE_TTS_READER__/);
  assert.match(contentScriptSource, /EDGE_TTS_SESSION_QUIT/);
});
