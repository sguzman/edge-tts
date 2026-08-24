const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backgroundPath = path.join(__dirname, "..", "src", "background.js");
const source = fs.readFileSync(backgroundPath, "utf8");

test("reliability and session wrappers load before reader construction", () => {
  const baseSpeech = source.indexOf('"src/content/speech-engine.js"');
  const reliableSpeech = source.indexOf('"src/content/reliable-speech-engine.js"');
  const toolbar = source.indexOf('"src/content/toolbar.js"');
  const quitToolbar = source.indexOf('"src/content/quit-toolbar.js"');
  const reader = source.indexOf('"src/content/reader.js"');
  const reliableReader = source.indexOf('"src/content/reliable-reader.js"');
  const failsafeReader = source.indexOf('"src/content/failsafe-reader.js"');
  const sessionReader = source.indexOf('"src/content/session-reader.js"');
  const bootstrap = source.indexOf('"src/content/content-script.js"');

  assert.ok(baseSpeech >= 0);
  assert.ok(reliableSpeech > baseSpeech);
  assert.ok(toolbar > reliableSpeech);
  assert.ok(quitToolbar > toolbar);
  assert.ok(reader > quitToolbar);
  assert.ok(reliableReader > reader);
  assert.ok(failsafeReader > reliableReader);
  assert.ok(sessionReader > failsafeReader);
  assert.ok(bootstrap > sessionReader);
});

test("background removes injected CSS when a session quits", () => {
  assert.match(source, /EDGE_TTS_SESSION_QUIT/);
  assert.match(source, /chrome\.scripting\s*\.removeCSS/);
});