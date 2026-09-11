const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {};
const {
  filterVoicesByClass,
  voiceClass,
  voiceLabel
} = require("../src/content/voice-ui.js");

const localWeb = {
  name: "Microsoft David",
  lang: "en-US",
  localService: true
};
const localChrome = {
  name: "Microsoft Mark",
  lang: "en-US",
  localService: true,
  __edgeTtsSource: "chrome-tts"
};
const natural = {
  name: "Microsoft Aria Online (Natural)",
  lang: "en-US",
  localService: false
};

test("voice classes distinguish Windows legacy, Windows Natural, and online", () => {
  assert.equal(voiceClass(localWeb), "win-legacy");
  assert.equal(voiceClass(localChrome), "win-legacy");
  assert.equal(voiceClass({ name: "Microsoft Aria", lang: "en-US", localService: true, __edgeTtsSource: "win-natural" }), "win-natural");
  assert.equal(voiceClass(natural), "online");
  assert.match(voiceLabel(localChrome), /^\[WIN-LEGACY\]/);
  assert.match(voiceLabel(natural), /^\[ONLINE\]/);
});

test("class filter and text search compose", () => {
  const voices = [localWeb, localChrome, natural];
  assert.deepEqual(filterVoicesByClass(voices, "", "win-legacy"), [localWeb, localChrome]);
  assert.deepEqual(filterVoicesByClass(voices, "aria", "online"), [natural]);
  assert.deepEqual(filterVoicesByClass(voices, "mark", "online"), []);
  assert.deepEqual(filterVoicesByClass(voices, "legacy", "all"), [localWeb, localChrome]);
});
