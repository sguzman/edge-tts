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

test("voice classes distinguish Windows local from Natural/Online", () => {
  assert.equal(voiceClass(localWeb), "local");
  assert.equal(voiceClass(localChrome), "local");
  assert.equal(voiceClass(natural), "natural");
  assert.match(voiceLabel(localChrome), /^\[LOCAL\]/);
  assert.match(voiceLabel(natural), /^\[NATURAL\]/);
});

test("class filter and text search compose", () => {
  const voices = [localWeb, localChrome, natural];
  assert.deepEqual(filterVoicesByClass(voices, "", "local"), [localWeb, localChrome]);
  assert.deepEqual(filterVoicesByClass(voices, "aria", "natural"), [natural]);
  assert.deepEqual(filterVoicesByClass(voices, "mark", "natural"), []);
  assert.deepEqual(filterVoicesByClass(voices, "local", "all"), [localWeb, localChrome]);
});
