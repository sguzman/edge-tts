const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {};
const { filterVoices } = require("../src/content/toolbar.js");

test("voice filter searches voice name and locale", () => {
  const voices = [
    { name: "Microsoft David", lang: "en-US" },
    { name: "Microsoft Helena", lang: "es-ES" },
    { name: "Microsoft Aria Online (Natural)", lang: "en-US" }
  ];

  assert.deepEqual(filterVoices(voices, "david"), [voices[0]]);
  assert.deepEqual(filterVoices(voices, "natural en-us"), [voices[2]]);
  assert.deepEqual(filterVoices(voices, "microsoft es-es"), [voices[1]]);
});
