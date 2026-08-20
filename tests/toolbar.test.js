const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {};
const { filterVoices } = require("../src/content/toolbar.js");

test("voice filter searches provider, locale, short name, and style", () => {
  const voices = [
    {
      id: "browser:David",
      name: "Microsoft David",
      lang: "en-US",
      provider: "Local",
      source: "local"
    },
    {
      id: "azure:en-US-JennyNeural",
      name: "Jenny",
      lang: "en-US",
      provider: "Azure",
      source: "azure",
      shortName: "en-US-JennyNeural",
      styles: ["chat"]
    }
  ];

  assert.deepEqual(filterVoices(voices, "azure chat"), [voices[1]]);
  assert.deepEqual(filterVoices(voices, "local david"), [voices[0]]);
  assert.deepEqual(filterVoices(voices, "jenny en-us"), [voices[1]]);
});
