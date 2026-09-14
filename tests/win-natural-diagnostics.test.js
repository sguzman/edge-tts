const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "diagnostics", "win-natural.js"), "utf8");
const html = fs.readFileSync(path.join(root, "diagnostics", "win-natural.html"), "utf8");
const host = fs.readFileSync(path.join(root, "native", "win-natural", "WinNaturalHost.cs"), "utf8");

test("diagnostics page is an extension-origin page with no ReaderApp dependency", () => {
  assert.match(html, /src="\.\.\/src\/background\/native-messaging\.js"/);
  assert.match(html, /src="\.\/win-natural\.js"/);
  assert.doesNotMatch(page, /ReaderApp|audioOwner|chrome\.tts/);
  assert.match(page, /EDGE_TTS_NATIVE_DIAGNOSTICS|diagnostics\(\)/);
});

test("diagnostics page uses the actual Local-* Aria token and owns audio cleanup", () => {
  assert.match(page, /voiceId: ariaVoice\.id/);
  assert.match(page, /requestMultipart\(\s*"synthesize"/s);
  assert.match(page, /generation/);
  assert.match(page, /audio\.pause\(\)/);
  assert.match(page, /URL\.revokeObjectURL/);
  assert.match(page, /requestGeneration !== generation/);
  assert.match(page, /Windows Natural diagnostic playback is working\./);
});

test("helper synthesis validates the actual Local token and SAPI selection", () => {
  assert.match(host, /voiceId\.StartsWith\("Local-", StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(host, /GetInstalledVoices\(\)/);
  assert.match(host, /string\.Equals\(voice\.VoiceInfo\.Id, voiceId, StringComparison\.Ordinal\)/);
  assert.match(host, /synthesizer\.SelectVoice\(selectedName\)/);
  assert.match(host, /synthesizer\.Voice\?\.Id, voiceId, StringComparison\.Ordinal/);
  assert.match(host, /SetOutputToWaveStream/);
  assert.match(host, /new MemoryStream/);
  assert.doesNotMatch(host, /SetOutputToDefaultAudioDevice/);
  assert.doesNotMatch(host, /File\.WriteAll/);
  assert.match(host, /SynthesisChunkBytes = 48 \* 1024/);
  assert.match(host, /MaxSynthesisBytes = 8 \* 1024 \* 1024/);
});
