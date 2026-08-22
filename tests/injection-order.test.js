const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backgroundPath = path.join(__dirname, "..", "src", "background.js");
const source = fs.readFileSync(backgroundPath, "utf8");

test("reliable speech wrapper loads before reader construction", () => {
  const baseSpeech = source.indexOf('"src/content/speech-engine.js"');
  const reliableSpeech = source.indexOf('"src/content/reliable-speech-engine.js"');
  const reader = source.indexOf('"src/content/reader.js"');
  const reliableReader = source.indexOf('"src/content/reliable-reader.js"');
  const bootstrap = source.indexOf('"src/content/content-script.js"');

  assert.ok(baseSpeech >= 0);
  assert.ok(reliableSpeech > baseSpeech);
  assert.ok(reader > reliableSpeech);
  assert.ok(reliableReader > reader);
  assert.ok(bootstrap > reliableReader);
});
