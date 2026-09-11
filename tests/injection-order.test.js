const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backgroundPath = path.join(__dirname, "..", "src", "background.js");
const source = fs.readFileSync(backgroundPath, "utf8");

test("speech backends, voice UI, controls, and startup fast path load before bootstrap", () => {
  const baseSpeech = source.indexOf('"src/content/speech-engine.js"');
  const reliableSpeech = source.indexOf('"src/content/reliable-speech-engine.js"');
  const directAudio = source.indexOf('"src/content/direct-audio-engine.js"');
  const localTts = source.indexOf('"src/content/local-tts-engine.js"');
  const toolbar = source.indexOf('"src/content/toolbar.js"');
  const voiceUi = source.indexOf('"src/content/voice-ui.js"');
  const reader = source.indexOf('"src/content/reader.js"');
  const reliableReader = source.indexOf('"src/content/reliable-reader.js"');
  const failsafeReader = source.indexOf('"src/content/failsafe-reader.js"');
  const audioControls = source.indexOf('"src/content/audio-controls.js"');
  const startupFastPath = source.indexOf('"src/content/startup-fastpath.js"');
  const bootstrap = source.indexOf('"src/content/content-script.js"');

  assert.ok(baseSpeech >= 0);
  assert.ok(reliableSpeech > baseSpeech);
  assert.ok(directAudio > reliableSpeech);
  assert.ok(localTts > directAudio);
  assert.ok(toolbar > localTts);
  assert.ok(voiceUi > toolbar);
  assert.ok(reader > voiceUi);
  assert.ok(reliableReader > reader);
  assert.ok(failsafeReader > reliableReader);
  assert.ok(audioControls > failsafeReader);
  assert.ok(startupFastPath > audioControls);
  assert.ok(bootstrap > startupFastPath);
  assert.equal(source.includes("boundaryless-fallback.js"), false);
  assert.equal(source.includes("quit-toolbar.js"), false);
  assert.equal(source.includes("session-reader.js"), false);
});

test("fresh injection does not spend an extra readiness round trip before Start", () => {
  const injectStart = source.indexOf("async function injectReader");
  const ensureStart = source.indexOf("async function ensureReader");
  const injectSource = source.slice(injectStart, ensureStart);

  assert.ok(injectStart >= 0 && ensureStart > injectStart);
  assert.match(injectSource, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(injectSource, /readerReady\(/);
});

test("Quit no longer asks the background to remove CSS and force full reinjection", () => {
  assert.equal(source.includes("EDGE_TTS_SESSION_QUIT"), false);
  assert.equal(source.includes("removeCSS"), false);
});
