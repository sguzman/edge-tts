const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
const contentScript = fs.readFileSync(path.join(__dirname, "..", "src", "content", "content-script.js"), "utf8");

test("Linux Piper backend is injected and wired to its native host", () => {
  assert.match(background, /src\/content\/linux-piper-engine\.js/);
  assert.match(background, /com\.sguzman\.edge_tts\.linux_piper/);
  assert.match(background, /EDGE_TTS_LINUX_PIPER_VOICES/);
  assert.match(background, /EDGE_TTS_LINUX_PIPER_SYNTHESIZE/);
  assert.match(background, /EDGE_TTS_LINUX_PIPER_STOP/);
  assert.match(background, /EDGE_TTS_LINUX_PIPER_EVENT/);
});

test("Linux Piper handshake requires Linux Piper CPU-only host", () => {
  assert.match(background, /message\.platform === "linux"/);
  assert.match(background, /message\.backend === "piper"/);
  assert.match(background, /message\.cpuOnly === true/);
});

test("content script forwards Linux Piper events to the active speech engine", () => {
  assert.match(contentScript, /EDGE_TTS_LINUX_PIPER_EVENT/);
  assert.match(contentScript, /handleLinuxPiperEvent/);
});
