const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const host = fs.readFileSync(
  path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"),
  "utf8"
);

test("Amy Low is the Linux Piper default by stable voice id", () => {
  assert.match(reader, /DEFAULT_LINUX_PIPER_VOICE_ID = "en_US-amy-low"/);
  assert.match(reader, /DEFAULT_LINUX_PIPER_VOICE_NAME = "Amy Low"/);
  assert.match(reader, /voice\.voiceId === DEFAULT_LINUX_PIPER_VOICE_ID/);
  assert.match(reader, /defaultPiperVoice/);
  assert.match(host, /voice_id = "en_US-amy-low"/);
});

test("passive voice refresh does not overwrite the saved preference", () => {
  const refreshStart = reader.indexOf("    refreshVoices() {");
  const speakStart = reader.indexOf("    speakCurrentPosition() {", refreshStart);
  const refreshBody = reader.slice(refreshStart, speakStart);

  assert.doesNotMatch(refreshBody, /this\.settings\.voiceName = this\.selectedVoice\.name/);
  assert.match(refreshBody, /this\.selectedVoice\?\.name \|\| savedVoiceName/);
});


test("settings v5 migrate the previous HFC default to Amy Low without overwriting other explicit voices", () => {
  assert.match(reader, /settingsVersion: 6/);
  assert.match(reader, /requiresAmyDefaultMigration = storedSettingsVersion < 6/);
  assert.match(reader, /PREVIOUS_LINUX_PIPER_DEFAULT_VOICE_ID = "en_US-hfc_female-medium"/);
  assert.match(reader, /migratePreviousDefaultToAmy/);
  assert.match(reader, /DEFAULT_LINUX_PIPER_VOICE_NAME = "Amy Low"/);
  assert.match(reader, /DEFAULT_LINUX_PIPER_VOICE_ID = "en_US-amy-low"/);
});

test("Piper catalog is discovered from installed model/config pairs", () => {
  assert.match(host, /VOICE_ROOT\.glob\("\*\.onnx"\)/);
  assert.match(host, /config_path\.is_file\(\)/);
  assert.match(host, /"voices": list_voices\(\)/);
});
