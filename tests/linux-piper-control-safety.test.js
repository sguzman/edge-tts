const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");
const piperEngine = fs.readFileSync(path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"), "utf8");
const piperHost = fs.readFileSync(path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"), "utf8");

test("Piper uses short CPU-sized chunks instead of online-sized batches", () => {
  assert.match(piperEngine, /firstChunkMaxChars:\s*Math\.min\(\s*180/);
  assert.match(piperEngine, /maxChars:\s*Math\.min\(\s*260/);
  assert.match(piperEngine, /emergencyMaxChars:\s*Math\.min\(\s*500/);
  assert.match(piperEngine, /PIPER_SYNTHESIS_TIMEOUT_MS = 20_000/);
  assert.match(piperEngine, /native synthesis timed out/);
});

test("Piper native cancellation is process-authoritative", () => {
  assert.match(piperHost, /PiperVoice\.load\(str\(model_path\), use_cuda=False\)/);
  assert.match(piperHost, /include_alignments=False/);
  assert.match(piperHost, /send_message\(\{"type": "cancelled"/);
  assert.match(piperHost, /os\._exit\(0\)/);
});

test("reader commits Stop and Pause state before native cancellation", () => {
  const stopStart = reader.indexOf("    stop() {");
  const playPauseStart = reader.indexOf("    async playPause() {");
  assert.ok(stopStart >= 0 && playPauseStart > stopStart);

  const stopBody = reader.slice(stopStart, playPauseStart);
  assert.ok(stopBody.indexOf("this.toolbar.setStopped()") < stopBody.indexOf("this.discardLocalSpeechState()"));

  const pauseBody = reader.slice(playPauseStart, reader.indexOf("    refreshText() {", playPauseStart));
  const pauseStatus = pauseBody.lastIndexOf('this.toolbar.setStatus("Paused")');
  const pauseCancel = pauseBody.lastIndexOf("this.discardLocalSpeechState()");
  assert.ok(pauseStatus >= 0);
  assert.ok(pauseCancel > pauseStatus);
});

test("reader invalidates stale startup work on lifecycle changes", () => {
  assert.match(reader, /this\.lifecycleSerial = 0/);
  assert.match(reader, /const lifecycle = \+\+this\.lifecycleSerial/);
  assert.match(reader, /lifecycle !== this\.lifecycleSerial/);
  assert.match(reader, /this\.lifecycleSerial \+= 1/);
});

test("Piper bypasses Web Audio and plays through a fresh direct media element", () => {
  assert.match(piperEngine, /Piper deliberately bypasses the shared Web Audio gain graph/);
  assert.match(piperEngine, /const audio = root\.document\?\.createElement\?\.\("audio"\)/);
  assert.match(piperEngine, /audio\.volume = Math\.min/);
  assert.match(piperEngine, /Playing Piper audio/);
});


test("Piper reactivates the highlight media clock for every sentence", () => {
  assert.match(
    piperEngine,
    /_speakLinuxPiperChunk\(generation\)[\s\S]*?this\.directActive = true/
  );
  assert.match(
    piperEngine,
    /audio\.onended = \(\) => \{[\s\S]*?this\.directActive = false/
  );
});
