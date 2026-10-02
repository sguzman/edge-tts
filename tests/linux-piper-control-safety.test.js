const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");
const piperEngine = fs.readFileSync(path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"), "utf8");
const piperHost = fs.readFileSync(path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"), "utf8");
const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
const offscreen = fs.readFileSync(path.join(__dirname, "..", "src", "offscreen", "piper-audio.js"), "utf8");

test("Piper uses real sentence chunks with bounded synthesis time", () => {
  assert.match(piperEngine, /createPiperSentenceChunks/);
  assert.match(piperEngine, /PIPER_SYNTHESIS_TIMEOUT_MS = 20_000/);
  assert.match(piperEngine, /native synthesis timed out/);
});

test("Piper native cancellation is process-authoritative", () => {
  assert.match(piperHost, /PiperVoice\.load\(str\(model_path\), use_cuda=False\)/);
  assert.match(piperHost, /include_alignments=False/);
  assert.match(piperHost, /send_message\(\{"type": "cancelled"/);
  assert.match(piperHost, /os\._exit\(0\)/);
});

test("Stop cancels local transport before releasing ownership and also hard-stops the tab", () => {
  const stopStart = reader.indexOf("    stop() {");
  const playPauseStart = reader.indexOf("    async playPause() {");
  assert.ok(stopStart >= 0 && playPauseStart > stopStart);

  const stopBody = reader.slice(stopStart, playPauseStart);
  const cancelAt = stopBody.indexOf("this.discardLocalSpeechState()");
  const hardStopAt = stopBody.indexOf("this.forceStopTabAudio()");
  const releaseAt = stopBody.indexOf("this.releaseAudioOwnership()");

  assert.ok(cancelAt >= 0);
  assert.ok(hardStopAt > cancelAt);
  assert.ok(releaseAt > cancelAt);
});

test("Pause requires acknowledgement and hard-stops playback if acknowledgement fails", () => {
  const playPauseStart = reader.indexOf("    async playPause() {");
  const refreshStart = reader.indexOf("    refreshText() {", playPauseStart);
  const body = reader.slice(playPauseStart, refreshStart);

  assert.match(body, /await Promise\.resolve\([\s\S]*?pauseInPlace/);
  assert.match(body, /pausedInPlace === true/);
  assert.match(body, /await this\.forceStopTabAudio\(\)/);
  assert.match(body, /Paused — playback hard-stopped/);
});

test("reader invalidates stale startup work on lifecycle changes", () => {
  assert.match(reader, /this\.lifecycleSerial = 0/);
  assert.match(reader, /const lifecycle = \+\+this\.lifecycleSerial/);
  assert.match(reader, /lifecycle !== this\.lifecycleSerial/);
  assert.match(reader, /this\.lifecycleSerial \+= 1/);
});

test("Piper uses extension-owned playback with two-sentence look-ahead", () => {
  assert.match(piperEngine, /linuxPiperPrefetchDepth = 2/);
  assert.match(piperEngine, /_fillLinuxPiperPrefetch/);
  assert.match(piperEngine, /_playLinuxPiperPreparedOffscreen/);
  assert.match(piperEngine, /EDGE_TTS_PIPER_OFFSCREEN_PLAY/);
});

test("Piper starts and ends highlight state from offscreen playback events", () => {
  assert.match(
    piperEngine,
    /event\.type === "started"[\s\S]*?this\.directActive = true/
  );
  assert.match(
    piperEngine,
    /event\.type === "ended"[\s\S]*?_finishLinuxPiperPreparedPlayback/
  );
});

test("Piper supports in-place pause and resume", () => {
  assert.match(piperEngine, /pauseInPlace\(\)/);
  assert.match(piperEngine, /resumeInPlace\(\)/);
  assert.match(reader, /this\.speech\?\.pauseInPlace\?\.\(\)/);
  assert.match(reader, /this\.speech\?\.resumeInPlace\?\.\(\)/);
});


test("playback failures keep the actual error visible after button state becomes stopped", () => {
  const errorStart = reader.indexOf("    handleError(error) {");
  const errorEnd = reader.indexOf("    handlePlaybackBlocked", errorStart);
  const body = reader.slice(errorStart, errorEnd);
  assert.ok(body.indexOf("this.toolbar.setStopped()") >= 0);
  assert.ok(
    body.indexOf("this.toolbar.setStatus(`Error:") >
      body.indexOf("this.toolbar.setStopped()")
  );
});


test("cold Piper startup gets exactly one automatic retry before surfacing failure", () => {
  assert.match(reader, /this\.initialPiperRetryRemaining = 1/);
  assert.match(reader, /!this\.sessionSpeechStarted/);
  assert.match(reader, /this\.initialPiperRetryRemaining > 0/);
  assert.match(reader, /this\.initialPiperRetryRemaining -= 1/);
  assert.match(reader, /retrying once/);
  assert.match(reader, /}, 300\);/);
});


test("background hard-stop does not depend on a remembered playback id", () => {
  assert.match(background, /EDGE_TTS_FORCE_STOP_TAB_AUDIO/);
  assert.match(background, /function forceStopAudioForTab/);
  assert.match(background, /hardStopOffscreenPiperForTab/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_STOP_TAB/);
  assert.match(offscreen, /ownerTabId === targetTabId/);
});

test("hard-stop retires every native Piper request owned by the tab", () => {
  const start = background.indexOf("function stopLinuxPiperForTab");
  const end = background.indexOf("async function hasLinuxPiperOffscreenDocument", start);
  const body = background.slice(start, end);

  assert.match(body, /\.filter\(\(\[, request\]\) =>/);
  assert.match(body, /for \(const \[activeKey\] of active\)/);
  assert.match(body, /linuxPiperRequests\.delete\(activeKey\)/);
});
