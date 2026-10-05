const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const host = fs.readFileSync(
  path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"),
  "utf8"
);
const engine = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"),
  "utf8"
);

test("Ryan stability profile keeps synthesis speed canonical", () => {
  assert.match(host, /_STABLE_NOISE_SCALE = 0\.50/);
  assert.match(host, /_STABLE_NOISE_W_SCALE = 0\.60/);
  assert.match(host, /_SHORT_NOISE_SCALE = 0\.35/);
  assert.match(host, /_SHORT_NOISE_W_SCALE = 0\.40/);
  assert.match(host, /def synthesis_config_for_text/);
  assert.match(host, /word_count <= 2/);
  assert.match(host, /length_scale=1\.0/);
  assert.match(host, /config = synthesis_config_for_text\(text\)/);
});


test("Piper stall recovery follows media time instead of reader-boundary silence", () => {
  assert.match(engine, /_armLinuxPiperProgressWatchdog\(generation, prepared\)/);
  assert.match(engine, /currentTime > lastTime \+ 0\.03/);
  assert.match(engine, /stagnantChecks >= 3/);
  assert.match(engine, /Piper media clock stopped advancing/);
  assert.match(engine, /startTimeSeconds: checkpoint/);
  assert.match(engine, /alreadyStarted: true/);
  assert.match(engine, /Playback started…/);
});
