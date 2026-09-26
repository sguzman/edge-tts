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

test("Piper uses extension-owned offscreen audio as its primary player", () => {
  const start = piper.indexOf("    _playLinuxPiperPrepared(generation, prepared) {");
  const end = piper.indexOf("    _failLinuxPiper(message) {", start);
  const body = piper.slice(start, end);

  assert.match(body, /_playLinuxPiperPreparedOffscreen/);
  assert.match(body, /primary Piper playback/);
  assert.doesNotMatch(body, /createElement\?\.\("audio"\)/);
  assert.doesNotMatch(body, /audio\.play\(\)/);
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
  assert.match(offscreen, /type: "boundary"/);
});


test("offscreen media clock emits canonical boundary indices", () => {
  assert.match(offscreen, /boundaryOffsets/);
  assert.match(offscreen, /type: "boundary"/);
  assert.match(offscreen, /boundaryIndex \+= 1/);
  assert.match(piper, /boundaryOffsets: this\.directBoundaries\.map/);
  assert.match(piper, /linux-piper-offscreen-boundary/);
});

test("Piper force-loads persisted pronunciation config before creating chunks", () => {
  const speakAt = piper.indexOf("    speak(block, startSegmentIndex, options = {}) {");
  const beginAt = piper.indexOf("    _beginLinuxPiperSpeak", speakAt);
  const body = piper.slice(speakAt, beginAt);
  assert.match(body, /loadConfig\?\.\(\{ force: true \}\)/);
  assert.match(body, /Loading pronunciation rules/);
});


test("primary offscreen playback cannot trigger the page-media blocked state race", () => {
  const playStart = piper.indexOf("    _playLinuxPiperPrepared(generation, prepared) {");
  const failStart = piper.indexOf("    _failLinuxPiper(message) {", playStart);
  const body = piper.slice(playStart, failStart);

  assert.doesNotMatch(body, /onPlaybackBlocked/);
  assert.doesNotMatch(body, /NotAllowedError/);
  assert.match(body, /this\.directBoundaryIndex = 0/);
  assert.match(body, /this\.currentChunkBoundaryIndex = -1/);
});


test("background relay preserves Piper boundary offsets for offscreen highlighting", () => {
  const routeAt = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PLAY"');
  const nextRoute = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE"', routeAt);
  const body = background.slice(routeAt, nextRoute);
  assert.match(body, /boundaryOffsets:/);
  assert.match(body, /message\.boundaryOffsets/);
  assert.match(body, /EDGE_TTS_OFFSCREEN_PIPER_PLAY/);
});
