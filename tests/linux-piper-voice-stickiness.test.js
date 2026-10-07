const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const fastPath = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
  "utf8"
);

test("reader persists voice backend identity, not name alone", () => {
  assert.match(reader, /settingsVersion: 6/);
  assert.match(reader, /voiceSource: "linux-piper"/);
  assert.match(reader, /voiceId: DEFAULT_LINUX_PIPER_VOICE_ID/);
  assert.match(reader, /function voiceSourceKey/);
  assert.match(reader, /this\.settings\.voiceSource = voiceSourceKey\(voice\)/);
  assert.match(reader, /this\.settings\.voiceId = isLinuxPiperVoice\(voice\)/);
});

test("saved Piper preference cannot silently fall through to Online", () => {
  const start = reader.indexOf("    refreshVoices() {");
  const end = reader.indexOf("    prefersLinuxPiper() {", start);
  const body = reader.slice(start, end);

  assert.match(body, /const prefersPiper/);
  assert.match(body, /this\.selectedVoice = prefersPiper/);
  assert.match(body, /voices\.find\(isLinuxPiperVoice\)/);
  assert.doesNotMatch(
    body.slice(body.indexOf("? ("), body.indexOf(": (")),
    /isNaturalVoice/
  );
});

test("startup retries Piper discovery and blocks Online fallback", () => {
  assert.match(reader, /async ensurePreferredVoiceAvailable\(\)/);
  assert.match(reader, /refreshLinuxPiperVoices/);
  assert.match(reader, /refusing Online fallback/);
  assert.match(fastPath, /ensurePreferredVoiceAvailable/);
  assert.match(fastPath, /Online fallback blocked/);
});
