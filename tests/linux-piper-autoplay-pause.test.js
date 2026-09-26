const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const toolbar = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "toolbar.js"),
  "utf8"
);
const piper = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"),
  "utf8"
);

test("blocked initial Piper autoplay is recoverable instead of becoming Stopped", () => {
  assert.match(piper, /error\?\.name === "NotAllowedError"/);
  assert.match(piper, /this\.linuxPiperPausedInPlace = true/);
  assert.match(piper, /this\.onPlaybackBlocked\?\.\(error\)/);
  assert.match(reader, /handlePlaybackBlocked\(error\)/);
  assert.match(reader, /this\.stopped = false/);
  assert.match(reader, /this\.paused = true/);
  assert.match(reader, /Ready — press Resume/);
});

test("Piper sentence pause is playback-only and configurable", () => {
  assert.match(reader, /DEFAULT_SENTENCE_PAUSE_MS = 300/);
  assert.match(reader, /sentencePauseMs: this\.settings\.sentencePauseMs/);
  assert.match(toolbar, /data-edge-tts-sentence-pause/);
  assert.match(toolbar, /Sentence pause/);
  assert.match(piper, /this\.currentOptions\?\.sentencePauseMs/);
  assert.match(piper, /this\.linuxPiperSentencePauseTimer = root\.setTimeout/);
});

test("sentence pause does not alter Piper synthesis text or native timing", () => {
  assert.doesNotMatch(piper, /lengthScale/);
  assert.doesNotMatch(piper, /piperRatePlan/);
  assert.match(piper, /audio\.playbackRate = this\.directPlaybackRate/);
});
