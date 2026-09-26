const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);
const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const piper = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"),
  "utf8"
);
const bootstrap = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "content-script.js"),
  "utf8"
);
const offscreen = fs.readFileSync(
  path.join(__dirname, "..", "src", "offscreen", "piper-audio.js"),
  "utf8"
);

test("pronunciation branch can create an extension-owned audio document", () => {
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /reasons: \["AUDIO_PLAYBACK"\]/);
  assert.match(background, /src\/offscreen\/piper-audio\.html/);
});

test("media code 4 and URL safety failures fall back instead of killing Piper", () => {
  assert.match(piper, /mediaCode === 4/);
  assert.match(piper, /URL safety check/);
  assert.match(piper, /_playLinuxPiperPreparedOffscreen/);
  assert.match(piper, /EDGE_TTS_PIPER_OFFSCREEN_PLAY/);
});

test("offscreen Piper events are routed back to the page reader", () => {
  assert.match(background, /EDGE_TTS_OFFSCREEN_PIPER_EVENT/);
  assert.match(background, /EDGE_TTS_PIPER_OFFSCREEN_EVENT/);
  assert.match(bootstrap, /handleLinuxPiperOffscreenEvent/);
  assert.match(piper, /handleLinuxPiperOffscreenEvent/);
});

test("extension-owned player supports transport and timing", () => {
  assert.match(offscreen, /audio\.play\(\)/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_PAUSE/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_RESUME/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_STOP/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_RATE/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_VOLUME/);
  assert.match(offscreen, /type: "time"/);
});
