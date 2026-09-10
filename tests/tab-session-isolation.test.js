const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const background = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
const reader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");
const reliableSpeech = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reliable-speech-engine.js"),
  "utf8"
);
const contentScript = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "content-script.js"),
  "utf8"
);

test("background serializes browser-audio ownership by tab", () => {
  assert.match(background, /let audioOwnerTabId = null/);
  assert.match(background, /let audioMutationChain = Promise\.resolve\(\)/);
  assert.match(background, /EDGE_TTS_AUDIO_CLAIM/);
  assert.match(background, /EDGE_TTS_AUDIO_RELEASE/);
  assert.match(background, /EDGE_TTS_AUDIO_PREEMPT/);
});

test("preemption is delivered to the old tab before ownership changes", () => {
  const preemptSend = background.indexOf("EDGE_TTS_AUDIO_PREEMPT");
  const assignment = background.indexOf("audioOwnerTabId = tabId", preemptSend);
  assert.ok(preemptSend >= 0);
  assert.ok(assignment > preemptSend);
});

test("content session checkpoints when another tab explicitly takes audio", () => {
  assert.match(contentScript, /EDGE_TTS_AUDIO_PREEMPT/);
  assert.match(contentScript, /suspendForOtherTab/);
});

test("Pause does not park a native speechSynthesis utterance", () => {
  assert.match(reader, /Never leave a native SpeechSynthesisUtterance parked in Edge/);
  assert.match(reader, /this\.discardLocalSpeechState\(\)/);
  assert.match(reader, /this\.releaseAudioOwnership\(\)/);
  assert.doesNotMatch(reader, /this\.speech\.pause\(\)/);
  assert.doesNotMatch(reader, /this\.speech\.resume\(\)/);
});

test("a non-owner discards only local state instead of globally canceling speech", () => {
  assert.match(reader, /if \(this\.audioOwner\) \{[\s\S]*?this\.speech\?\.cancel\?\.\(\);[\s\S]*?\} else \{[\s\S]*?this\.speech\?\.abandon\?\.\(\);/);
  assert.match(reliableSpeech, /abandon\(\) \{/);
  const abandonStart = reliableSpeech.indexOf("abandon() {");
  const abandonEnd = reliableSpeech.indexOf("\n    speak(", abandonStart);
  const abandonBody = reliableSpeech.slice(abandonStart, abandonEnd);
  assert.doesNotMatch(abandonBody, /synth\?\.cancel|synth\.cancel/);
});
