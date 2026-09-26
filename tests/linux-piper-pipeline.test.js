const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const piper = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"),
  "utf8"
);
const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const host = fs.readFileSync(
  path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"),
  "utf8"
);

test("Piper pipelines two sentences ahead while preserving sentence chunks", () => {
  assert.match(piper, /linuxPiperPrefetchDepth = 2/);
  assert.match(piper, /createPiperSentenceChunks/);
  assert.match(piper, /_fillLinuxPiperPrefetch/);
  assert.match(piper, /linuxPiperPrepared/);
});

test("reader pause/resume uses Piper in-place media controls before resynthesis", () => {
  const playPause = reader.slice(
    reader.indexOf("    async playPause() {"),
    reader.indexOf("    refreshText() {")
  );
  assert.match(playPause, /resumeInPlace/);
  assert.match(playPause, /pauseInPlace/);
});

test("click-to-seek replaces active speech before moving the cursor", () => {
  const click = reader.slice(
    reader.indexOf("    async handlePageClick(event) {"),
    reader.indexOf("    caretFromPoint", reader.indexOf("    async handlePageClick(event) {"))
  );
  assert.ok(click.indexOf("this.discardLocalSpeechState()") < click.indexOf("this.currentBlockIndex = block.index"));
  assert.match(click, /const lifecycle = \+\+this\.lifecycleSerial/);
});

test("Piper cancel immediately invalidates its native port and stale disconnects cannot kill replacements", () => {
  assert.match(background, /linuxPiperPort = null;\s*linuxPiperHandshake = null;/);
  assert.match(background, /if \(linuxPiperPort === port\)/);
  assert.match(background, /stopLinuxPiperForTab\(tabId\);[\s\S]*ensureLinuxPiperPort/);
});

test("native Piper helper advertises idle before synthesisEnd for immediate prefetch handoff", () => {
  const clearAt = host.indexOf("clear_active_request(request_id)", host.indexOf("# Mark the helper idle"));
  const endAt = host.indexOf('"type": "synthesisEnd"', clearAt);
  assert.ok(clearAt >= 0 && endAt > clearAt);
});


test("Ryan warms in parallel with native host startup", () => {
  assert.match(host, /_voice_load_lock = threading\.Lock\(\)/);
  assert.match(host, /def start_default_voice_warmup\(\)/);
  assert.match(host, /target=warm_default_voice/);
  const mainAt = host.indexOf("def main() -> None:");
  const warmAt = host.indexOf("start_default_voice_warmup()", mainAt);
  const loopAt = host.indexOf("while True:", mainAt);
  assert.ok(warmAt > mainAt && loopAt > warmAt);
});

test("next Piper sentence prefetch starts before current prepared sentence playback", () => {
  const marker = "request.chunkIndex === this.currentChunkIndex";
  const branchAt = piper.lastIndexOf(marker);
  const fillAt = piper.indexOf("this._fillLinuxPiperPrefetch(request.generation);", branchAt);
  const playAt = piper.indexOf("this._speakLinuxPiperChunk(request.generation);", branchAt);
  assert.ok(branchAt >= 0 && fillAt > branchAt && playAt > fillAt);
});

test("Piper synthesis remains canonical 1x and user speed stays in media playback", () => {
  assert.match(host, /SynthesisConfig\(length_scale=1\.0\)/);
  assert.doesNotMatch(host, /message\.get\("lengthScale"\)/);
  assert.doesNotMatch(background, /lengthScale/);
  assert.doesNotMatch(piper, /piperRatePlan/);
  assert.doesNotMatch(piper, /linuxPiperLengthScale/);
  assert.match(
    piper,
    /this\.directPlaybackRate = Math\.min\([\s\S]*?Number\(options\.rate\) \|\| 1/
  );
  assert.match(piper, /audio\.playbackRate = this\.directPlaybackRate/);
});
