const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);

test("Ryan High is the Linux Piper default by stable voice id", () => {
  assert.match(reader, /DEFAULT_LINUX_PIPER_VOICE_ID = "en_US-ryan-high"/);
  assert.match(reader, /voice\.voiceId === DEFAULT_LINUX_PIPER_VOICE_ID/);
  assert.match(reader, /defaultRyan/);
});

test("passive voice refresh does not overwrite the saved preference", () => {
  const refreshStart = reader.indexOf("    refreshVoices() {");
  const speakStart = reader.indexOf("    speakCurrentPosition() {", refreshStart);
  const refreshBody = reader.slice(refreshStart, speakStart);

  assert.doesNotMatch(refreshBody, /this\.settings\.voiceName = this\.selectedVoice\.name/);
  assert.match(refreshBody, /savedVoiceName \|\| this\.selectedVoice\?\.name/);
});


test("settings v2 migrate once to Ryan High", () => {
  assert.match(reader, /settingsVersion: 3/);
  assert.match(reader, /requiresRyanDefaultMigration = storedSettingsVersion < 3/);
  assert.match(reader, /voiceName: requiresRyanDefaultMigration/);
  assert.match(reader, /\? "Ryan High"/);
});
