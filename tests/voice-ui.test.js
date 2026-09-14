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
const winNatural = {
  name: "Microsoft Aria",
  lang: "en-US",
  localService: false,
  __edgeTtsSource: "win-natural",
  nativeVoiceId: "Local-NarratorVoices",
  catalogOnly: true
};

test("voice classes distinguish Windows Legacy, Windows Natural, and Online Natural", () => {
  assert.equal(voiceClass(localWeb), "win-legacy");
  assert.equal(voiceClass(localChrome), "win-legacy");
  assert.equal(voiceClass(winNatural), "win-natural");
  assert.equal(voiceClass(natural), "online-natural");
  assert.match(voiceLabel(localChrome), /^\[WIN-LEGACY\]/);
  assert.match(voiceLabel(winNatural), /^\[WIN-NATURAL\]/);
  assert.match(voiceLabel(natural), /^\[ONLINE\]/);
});

test("class filter and text search compose", () => {
  const voices = [localWeb, localChrome, winNatural, natural];
  assert.deepEqual(filterVoicesByClass(voices, "", "win-legacy"), [localWeb, localChrome]);
  assert.deepEqual(filterVoicesByClass(voices, "aria", "win-natural"), [winNatural]);
  assert.deepEqual(filterVoicesByClass(voices, "aria", "online-natural"), [natural]);
  assert.deepEqual(filterVoicesByClass(voices, "legacy", "all"), [localWeb, localChrome]);
});
